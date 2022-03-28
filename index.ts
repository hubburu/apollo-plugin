import type {
  ApolloServerPlugin,
  GraphQLRequestContext,
} from "apollo-server-plugin-base";
import { createHash } from "crypto";
import { GraphQLSchema, printSchema } from "graphql";
import util from "util";
import { gzip as nonPromiseGzip } from "zlib";
import fetch from "node-fetch";

/**
 * Assume that only one schema can run at the same time.
 */
let schemaSha256: string;
let savedContextToRequestId: (
  context: GraphQLRequestContext["context"]
) => string;

const gzip = util.promisify(nonPromiseGzip);

const toReportTime = ([seconds, nanoSeconds]) => {
  //ms with 2 point precision
  return Math.round(100000 * seconds + nanoSeconds / 10000) / 100;
};

const requestData = {};

export const wrapSyncFunction = (
  name: string,
  context: GraphQLRequestContext["context"],
  fn: (...args: any[]) => any
) => {
  return (...args: any[]) => {
    const requestId = savedContextToRequestId(context);
    if (!requestId || typeof requestId !== "string") {
      console.warn(
        `requestId was ${requestId} (type: ${typeof requestId}). Needs to be a string`
      );
    }
    requestData[requestId] ??= {};
    const startTime = process.hrtime();
    const offset = process.hrtime(requestData[requestId].requestStartTime);

    const logTime = () => {
      if (!savedContextToRequestId) {
        console.warn("Plugin is not configured with a requestId function");
        return;
      }
      requestData[requestId].loaders ??= {};
      requestData[requestId].loaders[name] ??= [];

      requestData[requestId].loaders[name].push([
        toReportTime(process.hrtime(startTime)),
        toReportTime(offset),
      ]);
    };
    try {
      const result = fn(...args);
      logTime();
      return result;
    } catch (e) {
      logTime();
      throw e;
    }
  };
};
export const wrapAsyncFunction = (
  name: string,
  context: GraphQLRequestContext["context"],
  fn: (...args: any[]) => Promise<any>
) => {
  return async (...args: any[]) => {
    const requestId = savedContextToRequestId(context);
    if (!requestId || typeof requestId !== "string") {
      console.warn(
        `requestId was ${requestId} (type: ${typeof requestId}). Needs to be a string`
      );
    }
    requestData[requestId] ??= {};
    const startTime = process.hrtime();
    const offset = process.hrtime(requestData[requestId].requestStartTime);

    const logTime = () => {
      if (!savedContextToRequestId) {
        console.warn("Plugin is not configured with a requestId function");
        return;
      }
      requestData[requestId].loaders ??= {};
      requestData[requestId].loaders[name] ??= [];

      requestData[requestId].loaders[name].push([
        toReportTime(process.hrtime(startTime)),
        toReportTime(offset),
      ]);
    };
    try {
      const result = await fn(...args);
      logTime();
      return result;
    } catch (e) {
      logTime();
      throw e;
    }
  };
};

export const wrapLoaderFunction = <T, K>(
  name: string,
  context: GraphQLRequestContext["context"],
  fn: (args: T[]) => Promise<K[]>
): ((args: T[]) => Promise<K[]>) => {
  return wrapAsyncFunction(name, context, fn) as (args: T[]) => Promise<K[]>;
};

const MAX_ERROR_BYTES = 1000;
const MAX_RESOLVER_BYTES = 2000;

const sha256 = (
  data: string | Buffer | DataView | NodeJS.TypedArray
): string => {
  const schemaHash = createHash("sha256");
  schemaHash.update(data);
  return schemaHash.digest("hex");
};

interface CommonPluginArgs<T> {
  contextToRequestId: (context: GraphQLRequestContext<T>["context"]) => string;
  apiKey?: string;
  /**
   * A function to determine if a certain operation should be traced. It is
   * common practice in performance tracing to only measure a subset of
   * operations to reduce overhead. A simple function you could use is
   * something like `() => Math.random() > 0.99`. Return true to include.
   */
  sampleFunction?: (ctx: GraphQLRequestContext<T>) => boolean;
  /**
   * If you wish to send the latest schema to Hubburu on server startup. The alternative is to send it with the pushHubburuSchema function in a CI pipeline.
   */
  pushSchemaOnStartup?: boolean;
  /**
   * A function to provide the current client name, to better track usage in
   * Hubburu.
   */
  getClientName?: (ctx: GraphQLRequestContext<T>) => string;
  /**
   * A function to provide the current client version, to better track usage
   * in Hubburu.
   */
  getClientVersion?: (ctx: GraphQLRequestContext<T>) => string;
  /**
   * A function to let you avoid sending a report that only creates noise in
   * your Hubburu dashboard (or pushes you to a new pricing tier).
   */
  shouldSend?: (report: HubburuReport) => boolean;
  /**
   * A string to identify the current environment. Like "staging" or
   * "production". Should match the call to pushHubburuSchema.
   */
  environment?: string;
}

interface ImmediatePluginArgs<T> extends CommonPluginArgs<T> {
  /**
   * sendMode will determine how the plugin will send the report to the Hubburu servers.
   * "IMMEDIATE" = send it before the response is sent to clients.
   * "BACKGROUND" = runs at an interval, which is being tracked in memory. Not suitable when running in an environment like AWS lambda.
   * "QUEUE" = you control it, suitable if you want to send reports from a background job. Use the queueReport argument to queue reports.
   */
  sendMode: "IMMEDIATE";
}

interface BackgroundPluginArgs<T> extends CommonPluginArgs<T> {
  sendMode: "BACKGROUND";
}

interface QueuePluginArgs<T> extends CommonPluginArgs<T> {
  sendMode: "QUEUE";
  /**
   * This function will be called when the plugin is done with the report.
   * The report should be sent using the sendHubburuReport function at a time of your choosing.
   */
  queueReport: (report: PendingReport) => Promise<any>;
}

type PluginArgs<T> =
  | ImmediatePluginArgs<T>
  | QueuePluginArgs<T>
  | BackgroundPluginArgs<T>;

interface PendingReport {
  report: string;
  apiKey: string;
}

export interface HubburuReport {
  resolvers?: string | null;
  operationName?: string;
  loaders?: { [name: string]: [number, number][] };
  requestId?: string;
  errors?: string | null;
  totalMs: number;
  createdAt?: string;
  clientName?: string;
  clientVersion?: string;
  environment?: string;
  gzippedOperationBody: string;
  meta?: {
    postProcessingTime?: number;
    resolversTooLarge?: number;
    errorsTooLarge?: number;
  };
}

const queue = [] as PendingReport[];
const runQueue = () => {
  setInterval(() => {
    while (queue.length > 0) {
      const report = queue.pop();
      sendHubburuReport(report);
    }
  }, 15000);
};
const queueReport = (report: PendingReport): void => {
  queue.push(report);
};

const reportUrl =
  process.env.HUBBURU_REPORT_URL || "https://report.hubburu.com";

export const sendHubburuReport = async ({ report, apiKey }: PendingReport) => {
  try {
    await fetch(`${reportUrl}/operation`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
      },
      body: report,
    });
  } catch (e) {
    console.warn("Hubburu report error", e);
  }
};

export const pushHubburuSchema = async ({
  schema,
  apiKey = process.env.HUBBURU_API_KEY,
  environment = "default",
}: {
  schema: GraphQLSchema;
  apiKey?: string;
  environment?: string;
}): Promise<void> => {
  if (!apiKey && process.env.NODE_ENV !== "test") {
    console.warn(
      "HUBBURU_API_KEY not found in env and not found in function arguments"
    );
  }
  const schemaSdl = printSchema(schema);
  const gzippedSchema = (await gzip(schemaSdl)).toString("base64");
  await fetch(`${reportUrl}/schema`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify({
      sdl: gzippedSchema,
      environment,
    }),
  });
};

export const HubburuApolloServerPlugin: <T = any>(
  arg: PluginArgs<T>
) => ApolloServerPlugin<T> = (args) => {
  const {
    contextToRequestId,
    sendMode,
    apiKey = process.env.HUBBURU_API_KEY,
    pushSchemaOnStartup = false,
    environment = "default",
    sampleFunction = () => true,
    shouldSend = () => true,
  } = args;
  savedContextToRequestId = contextToRequestId;

  if (!apiKey && process.env.NODE_ENV !== "test") {
    console.warn(
      "HUBBURU_API_KEY not found in env and not found in function arguments"
    );
    return {};
  }
  if (process.env.NODE_ENV === "test") {
    return {};
  }
  return {
    serverWillStart: async (service) => {
      if (sendMode === "BACKGROUND") {
        runQueue();
      }
      try {
        const schemaSdl = printSchema(service.schema);
        schemaSha256 = sha256(schemaSdl);
        if (pushSchemaOnStartup) {
          pushHubburuSchema({ schema: service.schema, apiKey, environment });
        }
      } catch (e) {
        console.error(e);
      }
    },
    requestDidStart: async (ctx) => {
      const requestStartTime = process.hrtime();
      const shouldTrace = sampleFunction(ctx);
      requestData[savedContextToRequestId(ctx.context)] = { requestStartTime };

      const tracing = [];

      return {
        executionDidStart: async () => {
          if (!shouldTrace) return;
          return {
            willResolveField: ({ info }) => {
              let path = info.fieldName;
              let prev = info.path.prev;
              while (prev) {
                path = prev.key + "." + path;
                prev = prev.prev;
              }
              const start = process.hrtime();
              const offset = process.hrtime(requestStartTime);
              return () => {
                tracing.push([
                  path,
                  toReportTime(process.hrtime(start)),
                  toReportTime(offset),
                ]);
              };
            },
          };
        },
        willSendResponse: async (requestContext) => {
          try {
            const postProcessingTimeStart = process.hrtime();
            const reqData =
              requestData[savedContextToRequestId(requestContext.context)];
            delete requestData[savedContextToRequestId(requestContext.context)];

            const stringOperation = requestContext.request.query;

            const errors = requestContext.errors?.map((e) => {
              return {
                message: e.message,
                extensions: e.extensions,
                details: e.stack,
              };
            });
            let [zippedErrors, zippedResolvers, zippedOperation] =
              await Promise.all([
                errors
                  ? gzip(JSON.stringify(errors))
                  : Promise.resolve(undefined),
                gzip(JSON.stringify(tracing)),
                stringOperation
                  ? await gzip(stringOperation)
                  : Promise.resolve(undefined),
              ]);

            const errorsTooLarge =
              (zippedErrors?.byteLength ?? 0) > MAX_ERROR_BYTES;
            if (errorsTooLarge) {
              zippedErrors = await gzip(JSON.stringify(errors.slice(0, 5)));
            }

            const resolversTooLarge =
              (zippedResolvers?.byteLength ?? 0) > MAX_RESOLVER_BYTES;
            const totalMs = toReportTime(process.hrtime(requestStartTime));

            if (resolversTooLarge) {
              const pathNormalized: {
                [key: string]: {
                  min: typeof tracing[number];
                  max: typeof tracing[number];
                };
              } = {};
              for (let i = 0; i < tracing.length; i++) {
                const trace = tracing[i];
                if (trace[0].match(/\.[0-9]+\./)) {
                  const normalized = trace[0].replace(/\.[0-9]+\./g, ".X.");
                  pathNormalized[normalized] ??= {
                    min: ["", Number.MAX_SAFE_INTEGER, 0],
                    max: ["", 0, 0],
                  };
                  if (trace[1] <= pathNormalized[normalized].min[1]) {
                    pathNormalized[normalized].min = trace;
                  }
                  if (trace[1] >= pathNormalized[normalized].max[1]) {
                    pathNormalized[normalized].max = trace;
                  }
                }
              }
              const newList: typeof tracing = [];
              for (const trace of tracing) {
                if (trace[0].match(/[0-9]/)) {
                  const normalized = trace[0].replace(/\.[0-9]+\./g, ".X.");
                  const fromNormalized = pathNormalized[normalized];
                  if (!fromNormalized) {
                    continue;
                  }
                  newList.push(fromNormalized.min);
                  if (fromNormalized.max[0] !== fromNormalized.min[0]) {
                    newList.push(fromNormalized.max);
                  }
                  delete pathNormalized[normalized];
                } else {
                  newList.push(trace);
                }
              }

              zippedResolvers = await gzip(
                JSON.stringify(
                  newList.slice(0, 200).sort((a, b) => a[2] - b[2])
                )
              );
            }

            const report: HubburuReport = {
              requestId: savedContextToRequestId(requestContext.context),
              errors: zippedErrors?.toString("base64"),
              totalMs,
              operationName: ctx.operationName,
              gzippedOperationBody: zippedOperation?.toString("base64"),
              loaders: reqData?.loaders,
              resolvers: zippedResolvers.toString("base64"),
              environment,
              createdAt: new Date().toISOString(),
              meta: {
                errorsTooLarge: errorsTooLarge ? errors.length : undefined,
                resolversTooLarge: resolversTooLarge
                  ? tracing.length
                  : undefined,
                postProcessingTime: toReportTime(
                  process.hrtime(postProcessingTimeStart)
                ),
              },
            };

            if (!shouldSend(report)) return;

            const stringReport = JSON.stringify(report);
            const pendingReport = { report: stringReport, apiKey };
            if (sendMode === "QUEUE") {
              await args.queueReport(pendingReport);
            } else if (sendMode === "IMMEDIATE") {
              await sendHubburuReport(pendingReport);
            } else {
              queueReport(pendingReport);
            }
          } catch (e) {
            console.error(e);
          }
        },
      };
    },
  };
};
