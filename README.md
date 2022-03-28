# Apollo Hubburu plugin

A middleware for integrating Hubburu with Apollo server

## Installation

```
npm install hubburu
```

## Usage

These are the integration points you need to make to integrate with Hubburu.

1. Add your API key
2. Upload schema SDL to Hubburu
3. Send operation reports to Hubburu
4. (Optional) Measure functions outside of the GraphQL context

### Adding Your API Key

Register for Hubburu, and you will be able to access your API Key from there. The recommended way is to add it to your environment variables. You can also add it manually to the Hubburu SDK calls.

### Upload schema

Either you can upload your schema on server startup. This is an OK way to do it but not suitable for all environments. If you want to manually send it (such as in a CI/CD pipeline) like this:

```javascript
const { pushHubburuSchema } = require("hubburu");

const schema = graphql.buildClientSchema(introspectionResult); // or get an instance of graphql.GraphQLSchema some other way.

pushHubburuSchema({ schema })
  .then(() => console.log("Schema pushed to hubburu"))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
```

### Send operation reports

This is done by adding the Hubburu middleware to the list of Apollo middlewares. Example:

```javascript
import { HubburuApolloServerPlugin } from "hubburu";

const server = new ApolloServer({
  schema,
  plugins: [
    HubburuApolloServerPlugin({
      contextToRequestId: (context) => context.requestId,
    }),
  ],
});
```

You control if a trace should be gathered (which adds overhead!) with the `sampleFunction` parameter.

### Measure Functions Outside of the GraphQL Context

Hubburu supports measuring functions outside the GraphQL Context. We call these "Loader functions".

To use this function you will need to provide your own Request ID. Hubburu will use this Request ID to connect the loader call to the GraphQL trace.
A common pattern is to generate a UUID v4 and attach it to your GraphQL context, and track that id throughout your different services. That kind of ID is suitable for this use case.

Hubburu exposes three functions for this purpose: `wrapLoaderFunction` (intended for dataloader), `wrapAsyncFunction` for generic async function and `wrapSyncFunction`.

**wrapLoaderFunction**

```javascript
const loaderFunction = async (ids) => {
  const users = await loadUsers(ids);
  const lookup = {};
  users.forEach((user) => {
    lookup[user.id] = user;
  });
  return ids.map((i) => lookup[i]);
})

const userLoaderWithoutHubburu = new DataLoader(loaderFunction);

const userLoaderWithHubburu = new DataLoader(
  wrapLoaderFunction('user', context, loaderFunction)
);
```

**wrapAsyncFunction**

```javascript
const functionToMeasure = () => {
  return fetch(...).json()
}

const withMeasuring = wrapAsyncFunction('load_misc_data', context, functionToMeasure);

//Now instead of functionToMeasure, use withMeasuring
const result = await withMeasuring()
```

**wrapSyncFunction**

```javascript
const functionToMeasure = () => {
  const hardComputation = 1 + 2;
  return hardComputation;
};

const withMeasuring = wrapAsyncFunction(
  "compute_data",
  context,
  functionToMeasure
);

//Now instead of functionToMeasure, use withMeasuring
const result = withMeasuring();
```

## Development & Testing

This plugin is being developed and tested in another repository. You are welcome to send bug reports either as an issue on Github or to [hello@hubburu.com](mailto:hello@hubburu.com).
