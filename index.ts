import type {
  ApolloServerPlugin,
  GraphQLRequestContext,
} from "apollo-server-plugin-base";
import { createHash } from "crypto";
import { printSchema } from "graphql";
import util from "util";
import { gzip as nonPromiseGzip } from "zlib";
import http from "http";
import https from "https";

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
  pushSchemaOnStartup?: boolean;
  environment?: string;
}

interface ImmediatePluginArgs<T> extends CommonPluginArgs<T> {
  sendMode: "IMMEDIATE";
}

interface QueuePluginArgs<T> extends CommonPluginArgs<T> {
  sendMode: "QUEUE";
  queueReport: (report: PendingReport) => Promise<any>;
}

type PluginArgs<T> = ImmediatePluginArgs<T> | QueuePluginArgs<T>;

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

const reportUrl =
  process.env.HUBBURU_REPORT_URL || "https://report.hubburu.com";
const parsedUrl = new URL(reportUrl);

const requestor = parsedUrl.protocol === "http:" ? http : https;

export const sendHubburuReport = ({ report, apiKey }: PendingReport) => {
  return new Promise<void>((resolve, reject) => {
    const request = requestor.request(
      {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || "443",
        path: "/operation",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
        },
      },
      (res) => {
        res.on("data", (d) => {
          process.stdout.write(d);
        });
        console.log(
          `reported to hubburu ${reportUrl}, status:${res.statusCode}`
        );
        resolve();
      }
    );
    const data = new TextEncoder().encode(report);
    request.write(data, (err) => {
      request.end();
    });
  });
};

export const HubburuApolloServerPlugin: <T = any>(
  arg: PluginArgs<T>
) => ApolloServerPlugin = (args) => {
  const {
    contextToRequestId,
    sendMode,
    apiKey = process.env.HUBBURU_API_KEY,
    pushSchemaOnStartup = false,
    environment = "default",
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
      try {
        const schemaSdl = printSchema(service.schema);
        schemaSha256 = sha256(schemaSdl);
        if (pushSchemaOnStartup) {
          const request = requestor.request({
            hostname: parsedUrl.hostname,
            port: parsedUrl.port || "443",
            path: "/schema",
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-api-key": apiKey,
            },
          });
          const gzippedSchema = (await gzip(schemaSdl)).toString("base64");
          const data = new TextEncoder().encode(
            JSON.stringify({
              sdl: gzippedSchema,
              environment,
            })
          );
          request.write(data, (err) => {
            console.error(err);
            request.end();
          });
        }
      } catch (e) {
        console.error(e);
      }
    },
    requestDidStart: async (ctx) => {
      const requestStartTime = process.hrtime();
      requestData[savedContextToRequestId(ctx.context)] = { requestStartTime };

      const tracing = [];

      return {
        executionDidStart: async () => {
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

            const stringReport = JSON.stringify(report);
            const pendingReport = { report: stringReport, apiKey };
            if (sendMode === "QUEUE") {
              await args.queueReport(pendingReport);
            } else {
              await sendHubburuReport(pendingReport);
            }
          } catch (e) {
            console.error(e);
          }
        },
      };
    },
  };
};
