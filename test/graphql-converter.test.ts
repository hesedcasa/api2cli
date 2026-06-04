import {expect} from 'chai'
import {buildSchema} from 'graphql'

import {
  convertSchema,
  hasGraphQLExtension,
  isIntrospectionPayload,
  parseSchemaSource,
} from '../src/graphql-converter.js'

describe('graphql-converter', () => {
  // ─── hasGraphQLExtension ──────────────────────────────────────────────────

  describe('hasGraphQLExtension', () => {
    it('returns true for .graphql extension', () => {
      expect(hasGraphQLExtension('schema.graphql')).to.be.true
    })

    it('returns true for .gql extension', () => {
      expect(hasGraphQLExtension('schema.gql')).to.be.true
    })

    it('returns true for .graphqls extension', () => {
      expect(hasGraphQLExtension('schema.graphqls')).to.be.true
    })

    it('is case-insensitive', () => {
      expect(hasGraphQLExtension('schema.GRAPHQL')).to.be.true
      expect(hasGraphQLExtension('schema.GQL')).to.be.true
    })

    it('returns false for .json extension', () => {
      expect(hasGraphQLExtension('introspection.json')).to.be.false
    })

    it('returns false for .ts extension', () => {
      expect(hasGraphQLExtension('schema.ts')).to.be.false
    })

    it('returns false for no extension', () => {
      expect(hasGraphQLExtension('schema')).to.be.false
    })
  })

  // ─── isIntrospectionPayload ───────────────────────────────────────────────

  describe('isIntrospectionPayload', () => {
    it('returns false for null', () => {
      expect(isIntrospectionPayload(null)).to.be.false
    })

    it('returns false for a string', () => {
      expect(isIntrospectionPayload('query { users { id } }')).to.be.false
    })

    it('returns false for object without __schema or data.__schema', () => {
      expect(isIntrospectionPayload({paths: {}})).to.be.false
    })

    it('returns true for bare __schema payload', () => {
      expect(isIntrospectionPayload({__schema: {types: []}})).to.be.true
    })

    it('returns true for wrapped {data: {__schema}} payload', () => {
      expect(isIntrospectionPayload({data: {__schema: {types: []}}})).to.be.true
    })
  })

  // ─── parseSchemaSource ────────────────────────────────────────────────────

  describe('parseSchemaSource', () => {
    const SDL = `
      type Query {
        hello: String
      }
    `

    it('parses a SDL string and returns a GraphQLSchema', () => {
      const schema = parseSchemaSource(SDL)
      expect(schema.getQueryType()?.name).to.equal('Query')
    })
  })

  // ─── convertSchema ────────────────────────────────────────────────────────

  describe('convertSchema', () => {
    const SDL = `
      type Query {
        users: [User]
        user(id: ID!): User
      }
      type Mutation {
        createUser(name: String!, email: String!): User
      }
      type User {
        id: ID
        name: String
        email: String
      }
    `

    it('extracts query operations', () => {
      const schema = buildSchema(SDL)
      const result = convertSchema(schema)
      const ids = result.operations.map((o) => o.operationId)
      expect(ids).to.include('users')
      expect(ids).to.include('user')
    })

    it('extracts mutation operations', () => {
      const schema = buildSchema(SDL)
      const result = convertSchema(schema)
      const mut = result.operations.find((o) => o.operationId === 'createUser')
      expect(mut).to.exist
      expect(mut?.graphql?.operationType).to.equal('mutation')
    })

    it('all operations use POST method', () => {
      const schema = buildSchema(SDL)
      const {operations} = convertSchema(schema)
      for (const op of operations) {
        expect(op.method).to.equal('post')
      }
    })

    it('maps required argument to required body param', () => {
      const schema = buildSchema(SDL)
      const {operations} = convertSchema(schema)
      const userOp = operations.find((o) => o.operationId === 'user')
      expect(userOp?.bodyParams.id).to.deep.include({required: true})
    })

    it('maps optional argument to non-required body param', () => {
      const sdl = `
        type Query {
          search(term: String): [String]
        }
      `
      const schema = buildSchema(sdl)
      const {operations} = convertSchema(schema)
      expect(operations[0].bodyParams.term).to.deep.include({required: false})
    })

    it('uses custom title when provided', () => {
      const schema = buildSchema(SDL)
      const result = convertSchema(schema, {title: 'My API'})
      expect(result.title).to.equal('My API')
    })

    it('defaults title to "GraphQL API"', () => {
      const schema = buildSchema(SDL)
      const result = convertSchema(schema)
      expect(result.title).to.equal('GraphQL API')
    })

    it('deduplicates operation IDs when query and mutation share a field name', () => {
      const sdl = `
        type Query {
          user(id: ID!): String
        }
        type Mutation {
          user(id: ID!): String
        }
      `
      const schema = buildSchema(sdl)
      const {operations} = convertSchema(schema)
      const ids = operations.map((o) => o.operationId)
      expect(ids).to.have.length(2)
      expect(new Set(ids).size).to.equal(2)
      expect(ids).to.include('user-mutation')
    })

    it('builds a GraphQL document string for the operation', () => {
      const schema = buildSchema(SDL)
      const {operations} = convertSchema(schema)
      const usersOp = operations.find((o) => o.operationId === 'users')
      expect(usersOp?.graphql?.query).to.include('query queryUsers')
      expect(usersOp?.graphql?.query).to.include('users')
    })

    it('generates one operation for schema with a non-default query type', () => {
      const sdl = `
        type Foo {
          bar: String
        }
        schema {
          query: Foo
        }
      `
      const schema = buildSchema(sdl)
      const {operations} = convertSchema(schema)
      expect(operations).to.have.length(1)
      expect(operations[0].graphql?.operationType).to.equal('query')
    })
  })
})
