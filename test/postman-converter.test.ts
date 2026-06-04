import {expect} from 'chai'

import {isPostmanCollection} from '../src/postman-converter.js'

describe('isPostmanCollection', () => {
  it('returns false for null', () => {
    expect(isPostmanCollection(null)).to.be.false
  })

  it('returns false for a plain string', () => {
    expect(isPostmanCollection('{}' as unknown)).to.be.false
  })

  it('returns false when object has no info field', () => {
    expect(isPostmanCollection({paths: {}})).to.be.false
  })

  it('returns false when info has no schema or _postman_id', () => {
    expect(isPostmanCollection({info: {name: 'test'}})).to.be.false
  })

  it('returns true when info.schema contains schema.getpostman.com', () => {
    const col = {
      info: {
        name: 'My Collection',
        schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
      },
    }
    expect(isPostmanCollection(col)).to.be.true
  })

  it('returns true when info has _postman_id string', () => {
    const col = {info: {_postman_id: 'abc-123', name: 'My Collection'}} // eslint-disable-line camelcase
    expect(isPostmanCollection(col)).to.be.true
  })

  it('returns false when info.schema is not a getpostman URL', () => {
    const col = {info: {name: 'test', schema: 'https://openapi.example.com/schema.json'}}
    expect(isPostmanCollection(col)).to.be.false
  })
})
