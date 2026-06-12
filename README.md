# api2cli

Import OpenAPI, Postman, and GraphQL specs and call their operations as native CLI commands

[![Version](https://img.shields.io/npm/v/@hesed/api2cli.svg)](https://npmjs.org/package/@hesed/api2cli)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](https://github.com/hesedcasa/@hesed/api2cli/blob/main/LICENSE)
[![Downloads/week](https://img.shields.io/npm/dw/@hesed/api2cli.svg)](https://npmjs.org/package/@hesed/api2cli)

<!-- toc -->
* [api2cli](#api2cli)
* [Usage](#usage)
* [Commands](#commands)
<!-- tocstop -->

# Usage

<!-- usage -->
```sh-session
$ npm install -g @hesed/api2cli
$ api COMMAND
running command...
$ api (--version)
@hesed/api2cli/0.3.2 linux-x64 node-v22.22.3
$ api --help [COMMAND]
USAGE
  $ api COMMAND
...
```
<!-- usagestop -->

# Commands

<!-- commands -->
* [`api api auth add API`](#api-api-auth-add-api)
* [`api api auth delete API`](#api-api-auth-delete-api)
* [`api api auth list API`](#api-api-auth-list-api)
* [`api api auth profile API`](#api-api-auth-profile-api)
* [`api api auth update API`](#api-api-auth-update-api)
* [`api api call NAME OPERATIONID`](#api-api-call-name-operationid)
* [`api api config NAME`](#api-api-config-name)
* [`api api import SOURCE`](#api-api-import-source)
* [`api api list [NAME]`](#api-api-list-name)
* [`api api remove NAME`](#api-api-remove-name)

## `api api auth add API`

Add an auth profile for an imported API

```
USAGE
  $ api api auth add API --type none|bearer|apikey|basic|custom [--api-key <value>] [--api-key-header <value>]
    [--base-url <value>] [--header <value>...] [--password <value>] [-p <value>] [--token <value>] [--username <value>]

ARGUMENTS
  API  API name

FLAGS
  -p, --profile=<value>         [default: default] Profile name
      --api-key=<value>         API key value (used with --type apikey)
      --api-key-header=<value>  [default: X-API-Key] Header name for the API key
      --base-url=<value>        Base URL for this profile (overrides spec base URL at call time)
      --header=<value>...       Custom header Key=Value (--type custom, repeatable)
      --password=<value>        Password for basic auth
      --token=<value>           Bearer token (used with --type bearer)
      --type=<option>           (required) Auth type
                                <options: none|bearer|apikey|basic|custom>
      --username=<value>        Username for basic auth

DESCRIPTION
  Add an auth profile for an imported API

EXAMPLES
  $ api api auth add petstore --type bearer --token sk-...

  $ api api auth add petstore --type apikey --api-key mykey -p prod

  $ api api auth add petstore --type basic --username user --password secret

  $ api api auth add petstore --type custom --header X-Tenant-ID=acme --header X-App-Key=secret

  $ api api auth add petstore --type bearer --token sk-... --base-url https://api.prod.example.com

  $ api api auth add petstore --type none
```

_See code: [src/commands/api/auth/add.ts](https://github.com/hesedcasa/api2cli/blob/v0.3.2/src/commands/api/auth/add.ts)_

## `api api auth delete API`

Delete an auth profile for an imported API

```
USAGE
  $ api api auth delete API [-p <value>]

ARGUMENTS
  API  API name

FLAGS
  -p, --profile=<value>  [default: default] Profile name to delete

DESCRIPTION
  Delete an auth profile for an imported API

EXAMPLES
  $ api api auth delete petstore

  $ api api auth delete petstore -p prod
```

_See code: [src/commands/api/auth/delete.ts](https://github.com/hesedcasa/api2cli/blob/v0.3.2/src/commands/api/auth/delete.ts)_

## `api api auth list API`

List auth profiles for an imported API

```
USAGE
  $ api api auth list API

ARGUMENTS
  API  API name

DESCRIPTION
  List auth profiles for an imported API

EXAMPLES
  $ api api auth list petstore
```

_See code: [src/commands/api/auth/list.ts](https://github.com/hesedcasa/api2cli/blob/v0.3.2/src/commands/api/auth/list.ts)_

## `api api auth profile API`

Get or set the default auth profile for an imported API

```
USAGE
  $ api api auth profile API [--default <value>]

ARGUMENTS
  API  API name

FLAGS
  --default=<value>  Profile to set as default

DESCRIPTION
  Get or set the default auth profile for an imported API

EXAMPLES
  $ api api auth profile petstore

  $ api api auth profile petstore --default prod
```

_See code: [src/commands/api/auth/profile.ts](https://github.com/hesedcasa/api2cli/blob/v0.3.2/src/commands/api/auth/profile.ts)_

## `api api auth update API`

Update an auth profile for an imported API

```
USAGE
  $ api api auth update API --type none|bearer|apikey|basic|custom [--api-key <value>] [--api-key-header <value>]
    [--base-url <value>] [--header <value>...] [--password <value>] [-p <value>] [--token <value>] [--username <value>]

ARGUMENTS
  API  API name

FLAGS
  -p, --profile=<value>         [default: default] Profile name
      --api-key=<value>         API key value (used with --type apikey)
      --api-key-header=<value>  [default: X-API-Key] Header name for the API key
      --base-url=<value>        Base URL for this profile (overrides spec base URL at call time)
      --header=<value>...       Custom header Key=Value (--type custom, repeatable)
      --password=<value>        Password for basic auth
      --token=<value>           Bearer token (used with --type bearer)
      --type=<option>           (required) Auth type
                                <options: none|bearer|apikey|basic|custom>
      --username=<value>        Username for basic auth

DESCRIPTION
  Update an auth profile for an imported API

EXAMPLES
  $ api api auth update petstore --type bearer --token sk-new

  $ api api auth update petstore --type apikey --api-key newkey -p prod

  $ api api auth update petstore --type bearer --token sk-... --base-url https://api.prod.example.com -p prod
```

_See code: [src/commands/api/auth/update.ts](https://github.com/hesedcasa/api2cli/blob/v0.3.2/src/commands/api/auth/update.ts)_

## `api api call NAME OPERATIONID`

Call an imported API operation

```
USAGE
  $ api api call NAME OPERATIONID [--base-url <value>] [--body <value>...] [--header <value>...] [--param
    <value>...] [-p <value>] [--raw] [--toon]

ARGUMENTS
  NAME         API name (as shown in 'api list')
  OPERATIONID  Operation ID to call (as shown in `api list <name>`)

FLAGS
  -p, --profile=<value>    Authentication profile name
      --base-url=<value>   Override the base URL for this request
      --body=<value>...    Request body field as key=value (repeatable)
      --header=<value>...  Extra request header as Key=Value (repeatable)
      --param=<value>...   Path or query parameter as key=value (repeatable)
      --raw                Print the raw response body without JSON formatting
      --toon               Encode JSON output with TOON for token-efficient LLM consumption

DESCRIPTION
  Call an imported API operation

EXAMPLES
  $ api api call petstore listPets

  $ api api call petstore getPetById --param petId=42

  $ api api call petstore createPet --body name=Fido --body tag=dog

  $ api api call petstore listPets --query limit=10 --header X-Trace=abc
```

_See code: [src/commands/api/call.ts](https://github.com/hesedcasa/api2cli/blob/v0.3.2/src/commands/api/call.ts)_

## `api api config NAME`

Update configuration for an imported API spec

```
USAGE
  $ api api config NAME [--base-url <value>] [--description <value>] [--insecure] [--rename <value>] [--title
    <value>]

ARGUMENTS
  NAME  API name (as shown in `api list`)

FLAGS
  --base-url=<value>     New base URL for API calls
  --description=<value>  New description for the spec
  --[no-]insecure        Skip TLS certificate verification (--no-insecure to disable)
  --rename=<value>       New short identifier for this API
  --title=<value>        New display title for the spec

DESCRIPTION
  Update configuration for an imported API spec

EXAMPLES
  $ api api config petstore --base-url https://api.example.com

  $ api api config petstore --rename mystore

  $ api api config petstore --title "My Petstore" --description "A pet store API"
```

_See code: [src/commands/api/config.ts](https://github.com/hesedcasa/api2cli/blob/v0.3.2/src/commands/api/config.ts)_

## `api api import SOURCE`

Import an OpenAPI spec, Postman collection, or GraphQL schema (SDL/introspection/endpoint) and register its operations as commands

```
USAGE
  $ api api import SOURCE [--api-key <value>] [--api-key-header <value>] [--auth-type none|bearer|apikey|basic]
    [--base-url <value>] [--graphql] [--insecure] [--name <value>] [--password <value>] [--selection-depth <value>]
    [--token <value>] [--username <value>]

ARGUMENTS
  SOURCE  Path to a local OpenAPI/Postman/GraphQL spec or URL (REST or GraphQL endpoint)

FLAGS
  --api-key=<value>          API key value (used with --auth-type apikey)
  --api-key-header=<value>   [default: X-API-Key] Header name for the API key
  --auth-type=<option>       Authentication type
                             <options: none|bearer|apikey|basic>
  --base-url=<value>         Override the base URL for API calls
  --graphql                  Treat the source as a GraphQL schema (SDL, introspection JSON, or live endpoint)
  --insecure                 Skip TLS certificate verification (for self-signed certs)
  --name=<value>             Short identifier for this API (defaults to title slug)
  --password=<value>         Password for basic auth
  --selection-depth=<value>  [default: 3] Max depth of auto-generated GraphQL selection sets (GraphQL imports only)
  --token=<value>            Bearer token (used with --auth-type bearer)
  --username=<value>         Username for basic auth

DESCRIPTION
  Import an OpenAPI spec, Postman collection, or GraphQL schema (SDL/introspection/endpoint) and register its operations
  as commands

EXAMPLES
  $ api api import ./petstore.json  --name petstore

  $ api api import ./postman_collection.json --name myapi

  $ api api import https://petstore3.swagger.io/api/v3/openapi.json

  $ api api import ./schema.graphql --base-url https://api.example.com/graphql

  $ api api import https://api.example.com/graphql --name github

  $ api api import ./api.yaml --auth-type bearer --token sk-...

  $ api api import ./api.yaml --auth-type apikey --api-key mykey --api-key-header X-API-Key

  $ api api import ./api.yaml --auth-type basic --username user --password pass
```

_See code: [src/commands/api/import.ts](https://github.com/hesedcasa/api2cli/blob/v0.3.2/src/commands/api/import.ts)_

## `api api list [NAME]`

List imported API specs and their available operations

```
USAGE
  $ api api list [NAME]

ARGUMENTS
  [NAME]  API name to list operations for (omit to list all imported APIs)

DESCRIPTION
  List imported API specs and their available operations

EXAMPLES
  $ api api list

  $ api api list petstore
```

_See code: [src/commands/api/list.ts](https://github.com/hesedcasa/api2cli/blob/v0.3.2/src/commands/api/list.ts)_

## `api api remove NAME`

Remove an imported API spec

```
USAGE
  $ api api remove NAME

ARGUMENTS
  NAME  API name to remove

DESCRIPTION
  Remove an imported API spec

EXAMPLES
  $ api api remove petstore
```

_See code: [src/commands/api/remove.ts](https://github.com/hesedcasa/api2cli/blob/v0.3.2/src/commands/api/remove.ts)_
<!-- commandsstop -->
