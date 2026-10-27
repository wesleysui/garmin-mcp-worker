/**
 * MCP tools over the Garmin Personal API.
 *
 * Practices borrowed from the open-source Personal API projects:
 * - long ranges are split into the windows each endpoint accepts (Garmin rejects longer ones);
 * - all-day sample arrays are left out unless asked for, so responses fit a model's context;
 * - one missing section (e.g. today's HRV before you've slept) never sinks a combined answer;
 * - a raw read-only escape hatch covers endpoints without a dedicated tool.
 * Field names come from Garmin's Swagger and real responses recorded by those projects.
 */
import { InputError, parseDate, resolveRange, today } from './dates';
import type { GarminClient } from './garmin';

type Args = Record<string, unknown>;
type Json = Record<string, unknown>;

export interface ToolContext {
  garmin: GarminClient;
  timeZone?: string;
}

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: Json;
  run(args: Args, ctx: ToolContext): Promise<unknown>;
}

// Range limits per endpoint, as enforced by Garmin.
const MAX_DAYS = { dailySummaries: 31, sleep: 31, bodyBattery: 31, stress: 28, hrv: 365 } as const;
const ACTIVITY_PAGE_MAX = 45;
const SAMPLE_ARRAY_LIMIT = 48;

// ---------------------------------------------------------------- schema helpers

const dateField = (what: string) => ({ type: 'string', format: 'date', description: `${what} (YYYY-MM-DD).` });
const singleDay = {
  type: 'object',
  properties: { date: dateField('Calendar date; defaults to today') },
  additionalProperties: false,
};
const rangeSchema = (defaultDays: number, maxDays: number, extra: Json = {}) => ({
  type: 'object',
  properties: {
    start_date: dateField('First day, inclusive'),
    end_date: dateField('Last day, inclusive; defaults to today'),
    days: {
      type: 'integer',
      minimum: 1,
      maximum: maxDays,
      description: `Number of days ending on end_date, used when start_date is omitted. Default ${defaultDays}.`,
    },
    ...extra,
  },
  additionalProperties: false,
});

// ---------------------------------------------------------------- shaping helpers

const num = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const round = (value: number | undefined, digits = 1) =>
  value === undefined ? undefined : Math.round(value * 10 ** digits) / 10 ** digits;
const hours = (seconds: unknown) => round(num(seconds) === undefined ? undefined : (seconds as number) / 3600, 2);
const get = (obj: unknown, ...path: string[]): unknown =>
  path.reduce<unknown>((acc, key) => (acc && typeof acc === 'object' ? (acc as Json)[key] : undefined), obj);

/** Drop nulls and empty objects; replace long sample arrays with a note unless samples were requested. */
export function compact(value: unknown, includeSamples = false): unknown {
  if (Array.isArray(value)) {
    if (!includeSamples && value.length > SAMPLE_ARRAY_LIMIT) {
      return { omitted_samples: value.length, hint: 'Call again with include_samples: true to get them.' };
    }
    return value.map((item) => compact(item, includeSamples));
  }
  if (value && typeof value === 'object') {
    const out: Json = {};
    for (const [key, item] of Object.entries(value)) {
      const shaped = compact(item, includeSamples);
      if (shaped === null || shaped === undefined) continue;
      if (typeof shaped === 'object' && !Array.isArray(shaped) && Object.keys(shaped).length === 0) continue;
      out[key] = shaped;
    }
    return out;
  }
  return value;
}

const unwrap = (page: unknown, key: string): unknown[] => {
  const list = get(page, key);
  return Array.isArray(list) ? list : Array.isArray(page) ? page : [];
};

function paceFromSpeed(metersPerSecond: number | undefined): string | undefined {
  if (!metersPerSecond || metersPerSecond <= 0) return undefined;
  const secondsPerKm = Math.round(1000 / metersPerSecond);
  return `${Math.floor(secondsPerKm / 60)}:${String(secondsPerKm % 60).padStart(2, '0')}/km`;
}

function activityRow(activity: unknown): Json {
  const a = (activity ?? {}) as Json;
  const type = get(a, 'activityType', 'typeKey') as string | undefined;
  const isFootActivity = !!type && /run|walk|hik|trail|treadmill/i.test(type);
  return compact({
    id: a.activityId,
    name: a.activityName,
    type,
    start_local: a.startTimeLocal,
    distance_km: round(num(a.distance) === undefined ? undefined : (a.distance as number) / 1000, 2),
    duration_min: round(num(a.duration) === undefined ? undefined : (a.duration as number) / 60, 1),
    avg_pace: isFootActivity ? paceFromSpeed(num(a.averageSpeed)) : undefined,
    avg_speed_kmh: !isFootActivity ? round(num(a.averageSpeed) === undefined ? undefined : (a.averageSpeed as number) * 3.6, 1) : undefined,
    avg_hr: a.averageHR,
    max_hr: a.maxHR,
    avg_cadence_spm: round(num(a.averageRunningCadenceInStepsPerMinute), 0),
    avg_power_w: a.avgPower,
    elevation_gain_m: round(num(a.elevationGain), 0),
    aerobic_te: round(num(a.aerobicTrainingEffect), 1),
    anaerobic_te: round(num(a.anaerobicTrainingEffect), 1),
    training_load: round(num(a.activityTrainingLoad), 0),
    vo2max: a.vO2MaxValue,
    calories: a.calories,
  }) as Json;
}

async function searchActivities(
  ctx: ToolContext,
  filters: { startDate?: string; endDate?: string; activityType?: string },
  limit: number,
  offset = 0
): Promise<unknown[]> {
  const results: unknown[] = [];
  while (results.length < limit) {
    const pageSize = Math.min(ACTIVITY_PAGE_MAX, limit - results.length);
    const page = await ctx.garmin.get('/activitylist-service/activities/search/activities', {
      start: offset + results.length,
      limit: pageSize,
      ...filters,
    });
    const rows = Array.isArray(page) ? page : [];
    results.push(...rows);
    if (rows.length < pageSize) break;
  }
  return results;
}

/** Run named sections concurrently; a failing section is reported instead of failing the whole call. */
async function sections(parts: Record<string, () => Promise<unknown>>): Promise<Json> {
  const names = Object.keys(parts);
  const settled = await Promise.allSettled(names.map((name) => parts[name]()));
  const out: Json = {};
  settled.forEach((result, i) => {
    out[names[i]] =
      result.status === 'fulfilled'
        ? (result.value ?? { no_data: 'Garmin has nothing for this yet (not synced, or not recorded by your device).' })
        : { error: result.reason instanceof Error ? result.reason.message : String(result.reason) };
  });
  return out;
}

// ---------------------------------------------------------------- data fetchers

const fetchDailySummaries = (ctx: ToolContext, start: string, end: string) =>
  ctx.garmin.ranged(start, end, MAX_DAYS.dailySummaries, async (a, b) =>
    unwrap(await ctx.garmin.get('/usersummary-service/v2/dailysummaries', { startDate: a, endDate: b }), 'data')
  );

const fetchSleepSummaries = (ctx: ToolContext, start: string, end: string) =>
  ctx.garmin.ranged(start, end, MAX_DAYS.sleep, (a, b) =>
    ctx.garmin.get('/sleep-service/sleep/dailySleepSummariesByDate', { startDate: a, endDate: b })
  );

const fetchHrvSummaries = (ctx: ToolContext, start: string, end: string) =>
  ctx.garmin.ranged(start, end, MAX_DAYS.hrv, async (a, b) =>
    unwrap(await ctx.garmin.get(`/hrv-service/hrv/daily/${a}/${b}`), 'hrvSummaries')
  );

const fetchBodyBattery = (ctx: ToolContext, start: string, end: string, chunks?: number) =>
  ctx.garmin.ranged(start, end, MAX_DAYS.bodyBattery, (a, b) =>
    ctx.garmin.get('/wellness-service/wellness/bodyBattery/reports/daily', { startDate: a, endDate: b, chunks })
  );

function recoveryRow(date: string, day?: Json, sleep?: Json, hrv?: Json): Json {
  return compact({
    date,
    hrv: hrv && {
      last_night_avg_ms: hrv.lastNightAvg,
      last_night_5min_high_ms: hrv.lastNight5MinHigh,
      weekly_avg_ms: hrv.weeklyAvg,
      status: hrv.status,
      baseline_balanced_ms:
        get(hrv, 'baseline', 'balancedLow') !== undefined
          ? [get(hrv, 'baseline', 'balancedLow'), get(hrv, 'baseline', 'balancedUpper')]
          : undefined,
      baseline_low_upper_ms: get(hrv, 'baseline', 'lowUpper'),
    },
    sleep: sleep && {
      hours: hours(sleep.sleepTimeSeconds),
      score: get(sleep, 'sleepScores', 'overall', 'value'),
      quality: get(sleep, 'sleepScores', 'overall', 'qualifierKey'),
      deep_h: hours(sleep.deepSleepSeconds),
      rem_h: hours(sleep.remSleepSeconds),
      light_h: hours(sleep.lightSleepSeconds),
      awake_h: hours(sleep.awakeSleepSeconds),
      avg_hr: sleep.avgHeartRate,
      avg_stress: sleep.avgSleepStress,
      avg_respiration: sleep.averageRespirationValue,
      sleep_need_min: get(sleep, 'sleepNeed', 'actual'),
    },
    // /usersummary-service/v2/dailysummaries nests these (heartRate.restingValue, …);
    // the flat names are the older single-day summary's, kept as a fallback.
    resting_hr: get(day, 'heartRate', 'restingValue') ?? day?.restingHeartRate,
    resting_hr_7d_avg: day?.lastSevenDaysAvgRestingHeartRate,
    body_battery: day && {
      overnight_charge: sleepCharge(day),
      high: get(day, 'bodyBattery', 'maxValue') ?? day.bodyBatteryHighestValue,
      low: get(day, 'bodyBattery', 'minValue') ?? day.bodyBatteryLowestValue,
      charged: get(day, 'bodyBattery', 'chargedValue') ?? day.bodyBatteryChargedValue,
      drained: get(day, 'bodyBattery', 'drainedValue') ?? day.bodyBatteryDrainedValue,
      at_wake: day.bodyBatteryAtWakeTime,
    },
    stress_avg: get(day, 'stress', 'avgLevel') ?? day?.averageStressLevel,
    intensity_min: day && {
      moderate: get(day, 'intensityMinutes', 'moderate') ?? day.moderateIntensityMinutes,
      vigorous: get(day, 'intensityMinutes', 'vigorous') ?? day.vigorousIntensityMinutes,
    },
    steps: get(day, 'movement', 'steps', 'value') ?? day?.totalSteps,
  }) as Json;
}

/** Body Battery gained during the night's sleep, from the day's SLEEP event. */
function sleepCharge(day: Json): number | undefined {
  const events = get(day, 'bodyBattery', 'activityEvents');
  if (!Array.isArray(events)) return undefined;
  const sleep = events.find((e) => get(e, 'eventType') === 'SLEEP');
  return num(get(sleep, 'bodyBatteryImpact'));
}

// ---------------------------------------------------------------- tools

export const TOOLS: ToolDefinition[] = [
  {
    name: 'garmin_get_recovery_trend',
    title: 'Recovery trend',
    description:
      'Day-by-day recovery table: overnight HRV (with status and personal baseline), sleep (score, stages, sleep need), resting heart rate, Body Battery (at wake, high, low, charged, drained), stress and intensity minutes. Best first call for questions about recovery, readiness, fatigue or whether to train hard. Garmin\'s own "Training Readiness" score is not available in the Personal API; reason from these inputs instead. Sleep and HRV belong to the morning you woke up.',
    inputSchema: rangeSchema(14, 90),
    async run(args, ctx) {
      const { start, end } = resolveRange(args, ctx.timeZone, 14, 90);
      const data = await sections({
        daily: () => fetchDailySummaries(ctx, start, end),
        sleep: () => fetchSleepSummaries(ctx, start, end),
        hrv: () => fetchHrvSummaries(ctx, start, end),
      });
      const byDate = (rows: unknown) => {
        const map = new Map<string, Json>();
        if (Array.isArray(rows)) for (const row of rows) {
          const date = get(row, 'calendarDate');
          if (typeof date === 'string') map.set(date, row as Json);
        }
        return map;
      };
      const daily = byDate(data.daily);
      const sleep = byDate(data.sleep);
      const hrv = byDate(data.hrv);
      const dates = [...new Set([...daily.keys(), ...sleep.keys(), ...hrv.keys()])].sort();
      const failed = Object.fromEntries(
        Object.entries(data).filter(([, v]) => !Array.isArray(v) && v && typeof v === 'object' && 'error' in (v as Json))
      );
      return compact({
        range: { start, end },
        units: { hrv: 'ms (RMSSD)', sleep: 'hours', heart_rate: 'bpm' },
        days: dates.map((d) => recoveryRow(d, daily.get(d), sleep.get(d), hrv.get(d))),
        failed_sections: Object.keys(failed).length ? failed : undefined,
      });
    },
  },
  {
    name: 'garmin_get_day',
    title: 'One day at a glance',
    description:
      'Everything for one date in a single call: daily summary (steps, resting HR, stress, Body Battery, intensity minutes), last night\'s sleep, HRV, the Body Battery report and the activities recorded that day.',
    inputSchema: singleDay,
    async run(args, ctx) {
      const date = args.date === undefined ? today(ctx.timeZone) : parseDate(args.date, 'date');
      const result = await sections({
        summary: async () => (await fetchDailySummaries(ctx, date, date))[0] ?? null,
        sleep: async () => (await fetchSleepSummaries(ctx, date, date))[0] ?? null,
        hrv: async () => (await fetchHrvSummaries(ctx, date, date))[0] ?? null,
        body_battery: async () => (await fetchBodyBattery(ctx, date, date))[0] ?? null,
        activities: async () => (await searchActivities(ctx, { startDate: date, endDate: date }, 20)).map(activityRow),
      });
      return compact({ date, ...result });
    },
  },
  {
    name: 'garmin_get_hrv',
    title: 'HRV for one night',
    description:
      'Overnight heart rate variability for one date: last-night average, 5-minute high, weekly average, status and baseline. Set include_readings for the individual ~5-minute readings.',
    inputSchema: {
      ...singleDay,
      properties: {
        ...singleDay.properties,
        include_readings: { type: 'boolean', description: 'Include every individual reading (large).' },
      },
    },
    async run(args, ctx) {
      const date = args.date === undefined ? today(ctx.timeZone) : parseDate(args.date, 'date');
      const data = await ctx.garmin.get(`/hrv-service/hrv/${date}`);
      return data === null ? { date, no_data: 'No HRV for this night yet.' } : compact(data, args.include_readings === true);
    },
  },
  {
    name: 'garmin_get_hrv_summaries',
    title: 'HRV history',
    description:
      'Nightly HRV summaries (last-night average, weekly average, 5-minute high, status, baseline) across a range of up to a year. Use for long-term HRV trends.',
    inputSchema: rangeSchema(30, 365),
    async run(args, ctx) {
      const { start, end } = resolveRange(args, ctx.timeZone, 30, 365);
      return compact({ range: { start, end }, summaries: await fetchHrvSummaries(ctx, start, end) });
    },
  },
  {
    name: 'garmin_get_sleep',
    title: 'One night of sleep',
    description:
      'Full detail for one night: sleep score and sub-scores, stages, timings, sleep need and overnight vitals (heart rate, respiration, SpO2, stress). The date is the morning you woke up.',
    inputSchema: {
      ...singleDay,
      properties: {
        ...singleDay.properties,
        include_samples: { type: 'boolean', description: 'Include minute-level overnight series (large).' },
      },
    },
    async run(args, ctx) {
      const date = args.date === undefined ? today(ctx.timeZone) : parseDate(args.date, 'date');
      const data = await ctx.garmin.get('/sleep-service/sleep/dailySleep', { date });
      return data === null ? { date, no_data: 'No sleep recorded for this night yet.' } : compact(data, args.include_samples === true);
    },
  },
  {
    name: 'garmin_get_body_battery',
    title: 'Body Battery',
    description:
      'Daily Body Battery reports: charged and drained values and the events behind them (sleep, activities, stress). Set chunks (e.g. 24 for hourly) to get the low and high of each part of the day.',
    inputSchema: rangeSchema(7, 90, {
      chunks: { type: 'integer', minimum: 1, maximum: 96, description: 'Split each day into this many intervals.' },
    }),
    async run(args, ctx) {
      const { start, end } = resolveRange(args, ctx.timeZone, 7, 90);
      const chunks = args.chunks === undefined ? undefined : Number(args.chunks);
      if (chunks !== undefined && (!Number.isInteger(chunks) || chunks < 1 || chunks > 96)) {
        throw new InputError('chunks must be an integer from 1 to 96');
      }
      return compact({ range: { start, end }, reports: await fetchBodyBattery(ctx, start, end, chunks) }, chunks !== undefined);
    },
  },
  {
    name: 'garmin_get_daily_summaries',
    title: 'Daily wellness summaries',
    description:
      'Raw daily wellness totals across a range: steps, distance, calories, resting/min/max heart rate, stress breakdown, Body Battery, respiration, SpO2, intensity minutes, floors. Prefer garmin_get_recovery_trend for recovery questions.',
    inputSchema: rangeSchema(7, 90),
    async run(args, ctx) {
      const { start, end } = resolveRange(args, ctx.timeZone, 7, 90);
      return compact({ range: { start, end }, days: await fetchDailySummaries(ctx, start, end) });
    },
  },
  {
    name: 'garmin_get_heart_rate',
    title: 'Heart rate for one day',
    description:
      'Resting, minimum and maximum heart rate for a date, the 7-day resting average and abnormal heart rate alerts. Set include_samples for the all-day readings.',
    inputSchema: {
      ...singleDay,
      properties: {
        ...singleDay.properties,
        include_samples: { type: 'boolean', description: 'Include the all-day readings (large).' },
      },
    },
    async run(args, ctx) {
      const date = args.date === undefined ? today(ctx.timeZone) : parseDate(args.date, 'date');
      const data = await ctx.garmin.get('/wellness-service/wellness/dailyHeartRate', { date });
      return data === null ? { date, no_data: 'No heart rate data for this date.' } : compact(data, args.include_samples === true);
    },
  },
  {
    name: 'garmin_get_stress',
    title: 'Daily stress',
    description: 'Daily stress level and time spent in each stress band across a range.',
    inputSchema: rangeSchema(7, 90),
    async run(args, ctx) {
      const { start, end } = resolveRange(args, ctx.timeZone, 7, 90);
      const rows = await ctx.garmin.ranged(start, end, MAX_DAYS.stress, (a, b) =>
        ctx.garmin.get(`/usersummary-service/stats/stress/daily/${a}/${b}`)
      );
      return compact({ range: { start, end }, days: rows });
    },
  },
  {
    name: 'garmin_search_activities',
    title: 'Search activities',
    description:
      'List activities, newest first, as compact rows: distance, duration, pace or speed, heart rate, cadence, power, elevation, training effect, training load and, when Garmin includes it, the VO2max estimate for the activity. Filter by date range and activity type (e.g. running, trail_running, cycling, strength_training).',
    inputSchema: {
      type: 'object',
      properties: {
        start_date: dateField('Earliest activity date'),
        end_date: dateField('Latest activity date'),
        activity_type: { type: 'string', description: 'Garmin activity type key, e.g. running, cycling.' },
        limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Maximum activities to return. Default 20.' },
        offset: { type: 'integer', minimum: 0, description: 'Skip this many results (paging). Default 0.' },
      },
      additionalProperties: false,
    },
    async run(args, ctx) {
      const startDate = args.start_date === undefined ? undefined : parseDate(args.start_date, 'start_date');
      const endDate = args.end_date === undefined ? undefined : parseDate(args.end_date, 'end_date');
      const limit = args.limit === undefined ? 20 : Number(args.limit);
      const offset = args.offset === undefined ? 0 : Number(args.offset);
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new InputError('limit must be 1 to 200');
      if (!Number.isInteger(offset) || offset < 0) throw new InputError('offset must be 0 or more');
      const activityType = typeof args.activity_type === 'string' && args.activity_type ? args.activity_type : undefined;
      const rows = await searchActivities(ctx, { startDate, endDate, activityType }, limit, offset);
      return { count: rows.length, activities: rows.map(activityRow) };
    },
  },
  {
    name: 'garmin_get_activity',
    title: 'Activity detail',
    description: 'Everything Garmin Connect stores for one activity (summary values and splits). Get the id from garmin_search_activities.',
    inputSchema: {
      type: 'object',
      properties: { activity_id: { type: 'integer', minimum: 1, description: 'Activity id.' } },
      required: ['activity_id'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const id = Number(args.activity_id);
      if (!Number.isSafeInteger(id) || id < 1) throw new InputError('activity_id must be a positive integer');
      const data = await ctx.garmin.get(`/activity-service/activity/${id}`);
      return data === null ? { activity_id: id, no_data: 'Activity not found.' } : compact(data);
    },
  },
  {
    name: 'garmin_get_profile',
    title: 'Profile and heart rate zones',
    description: 'Units, time zone and training-day preferences, plus heart rate zones per sport and the method they are based on.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async run(_args, ctx) {
      return compact(
        await sections({
          settings: () => ctx.garmin.get('/userprofile-service/userprofile/settings'),
          heart_rate_zones: () => ctx.garmin.get('/biometric-service/heartRateZones/v2'),
        })
      );
    },
  },
  {
    name: 'garmin_api_get',
    title: 'Raw Personal API read',
    description:
      'Read-only GET on any Garmin Personal API path, for endpoints without a dedicated tool (e.g. /usersummary-service/stats/steps/daily/{start}/{end}, /fitnessage-service/fitnessage/v2/{date}, /wellness-service/wellness/daily/spo2acclimation/{date}, /usersummary-service/stats/hydration/daily/{start}/{end}). Paths are listed in Garmin\'s Personal API Swagger.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'API path starting with /, without the host.' },
        params: {
          type: 'object',
          description: 'Query parameters.',
          additionalProperties: { type: ['string', 'number', 'boolean'] },
        },
        include_samples: { type: 'boolean', description: 'Keep long arrays instead of summarising them.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const path = String(args.path ?? '');
      if (!/^\/[A-Za-z0-9._~\-/]+$/.test(path) || path.includes('..') || path.includes('//')) {
        throw new InputError('path must be a plain API path such as /hrv-service/hrv/2026-10-20');
      }
      if (path.startsWith('/personalapitoken-service')) throw new InputError('The token endpoint is not available.');
      const params: Record<string, string | number | boolean> = {};
      if (args.params && typeof args.params === 'object') {
        for (const [key, value] of Object.entries(args.params as Json)) {
          if (['string', 'number', 'boolean'].includes(typeof value)) params[key] = value as string | number | boolean;
        }
      }
      const data = await ctx.garmin.get(path, params);
      return data === null ? { no_data: true } : compact(data, args.include_samples === true);
    },
  },
];
