import type {
  ApolloServerPlugin,
  GraphQLRequestContext,
} from "apollo-server-plugin-base";
import { createHash, randomBytes } from "crypto";
import { GraphQLSchema, Kind, printSchema, TypeNode } from "graphql";
import fetch from "node-fetch";
import util from "util";
import { gzip as nonPromiseGzip } from "zlib";

let savedContextToRequestId: (
  context: GraphQLRequestContext["context"]
) => string;

const gzip = util.promisify(nonPromiseGzip);

const toReportTime = ([seconds, nanoSeconds]) => {
  //ms with 2 point precision
  return Math.round(100000 * seconds + nanoSeconds / 10000) / 100;
};

const requestData = {};

const MAX_ERROR_BYTES = 1000;

interface CommonPluginArgs<T> {
  contextToRequestId: (context: GraphQLRequestContext<T>["context"]) => string;
  apiKey?: string;
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
  requestId?: string;
  errors?: string | null;
  totalMs: number;
  createdAt?: string;
  clientName?: string;
  clientVersion?: string;
  environment?: string;
  enums?: { [name: string]: string[] };
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

const getTypeName = (v: TypeNode): string => {
  switch (v.kind) {
    case Kind.NAMED_TYPE:
      return v.name.value;
    case Kind.LIST_TYPE:
    case Kind.NON_NULL_TYPE:
      return getTypeName(v.type);
    default:
      return "";
  }
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
  let enumNames = new Set<string>();
  return {
    serverWillStart: async (service) => {
      if (!sendMode || sendMode === "BACKGROUND") {
        runQueue();
      }
      Object.values(service.schema.getTypeMap()).forEach((val) => {
        if (val.astNode?.kind === Kind.ENUM_TYPE_DEFINITION) {
          enumNames.add(val.astNode.name.value);
        }
      });
      try {
        if (pushSchemaOnStartup) {
          pushHubburuSchema({ schema: service.schema, apiKey, environment });
        }
      } catch (e) {
        console.error(e);
      }
    },
    requestDidStart: async (ctx) => {
      const requestStartTime = process.hrtime();
      const requestId =
        savedContextToRequestId?.(ctx.context) ??
        (await new Promise((r) =>
          randomBytes(48, (err, buf) => r(buf.toString("hex")))
        ));
      requestData[requestId] = { requestStartTime };
      return {
        executionDidStart: async (executionStartContext) => {
          const operationEnums: { [key: string]: Set<string> } = {};
          let hasEnums = false;
          executionStartContext.operation.variableDefinitions?.forEach((d) => {
            const variableTypeName = getTypeName(d.type);
            if (enumNames.has(variableTypeName)) {
              hasEnums = true;
              operationEnums[variableTypeName] ??= new Set<string>();
              operationEnums[variableTypeName].add(
                executionStartContext.request.variables[d.variable.name.value]
              );
            }
          });
          if (hasEnums) {
            requestData[requestId].enums = operationEnums;
          }
        },
        willSendResponse: async (requestContext) => {
          try {
            const postProcessingTimeStart = process.hrtime();
            const reqData = requestData[requestId];
            delete requestData[requestId];

            const stringOperation = requestContext.request.query;

            const errors = requestContext.errors?.map((e) => {
              return {
                message: e.message,
                extensions: e.extensions,
                details: e.stack,
              };
            });
            let [zippedErrors, zippedOperation] = await Promise.all([
              errors
                ? gzip(JSON.stringify(errors))
                : Promise.resolve(undefined),
              stringOperation
                ? await gzip(stringOperation)
                : Promise.resolve(undefined),
            ]);

            const errorsTooLarge =
              (zippedErrors?.byteLength ?? 0) > MAX_ERROR_BYTES;
            if (errorsTooLarge) {
              zippedErrors = await gzip(JSON.stringify(errors.slice(0, 5)));
            }

            const totalMs = toReportTime(process.hrtime(requestStartTime));

            const report: HubburuReport = {
              requestId,
              errors: zippedErrors?.toString("base64"),
              totalMs,
              operationName: ctx.operationName,
              gzippedOperationBody: zippedOperation?.toString("base64"),
              environment,
              createdAt: new Date().toISOString(),
              clientName: args.getClientName?.(ctx),
              clientVersion: args.getClientVersion?.(ctx),
              meta: {
                errorsTooLarge: errorsTooLarge ? errors.length : undefined,
                postProcessingTime: toReportTime(
                  process.hrtime(postProcessingTimeStart)
                ),
              },
            };

            if (reqData.enums) {
              report.enums = {};
              Object.entries(
                reqData.enums as { [key: string]: Set<string> }
              ).forEach(([key, set]) => {
                report.enums[key] = Array.from(set);
              });
            }

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
