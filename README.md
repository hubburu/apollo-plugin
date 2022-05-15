<a href="https://www.npmjs.com/package/hubburu"><img src="https://badge.fury.io/js/hubburu.svg"></a>

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

### Adding Your API Key

Register for Hubburu, and you will be able to access your API Key from there. The recommended way is to add it to your environment variables. You can also add it manually to the Hubburu SDK calls.

### Upload schema

Either you can upload your schema on server startup. This is an OK way to do it but not suitable for all environments. If you want to manually send it (such as in a CI/CD pipeline), you can do so like this:

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

## Development & Testing

This plugin is being developed and tested in another repository. You are welcome to send bug reports either as an issue on Github or to [hello@hubburu.com](mailto:hello@hubburu.com).
