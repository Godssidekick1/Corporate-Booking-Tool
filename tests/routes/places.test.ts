import { describe, it, expect, beforeAll } from 'vitest'
import { GET as countriesGet } from '@/app/api/reference/countries/route'
import { GET as regionsGet } from '@/app/api/reference/regions/route'
import { GET as citiesGet } from '@/app/api/reference/cities/route'
import { PATCH as profilePatch } from '@/app/api/tmc/traveler-profiles/[id]/route'
import { normalisePlaces } from '@/app/lib/places/normalisePlaces'
import { genderForTitle, toDateInput, fromDateInput } from '@/app/lib/places/profileFormat'
import { call } from '../harness/call'
import { actors, type Actors } from '../harness/actors'
import { resetDatabase } from '../harness/db'
import { db } from '@/app/lib/db'
import { sql, one, exec } from '@/app/lib/db/sql'

// ── Places: countries, states, cities ────────────────────────────────────────
// Countries and states come with the migration (GeoNames). Cities are loaded
// by scripts/load-cities.mjs, so a database may not have them: the template
// does not, and the tests that need them insert a handful.
// ─────────────────────────────────────────────────────────────────────────────

const HAS_DB = Boolean(process.env.DATABASE_URL)
const d = HAS_DB ? describe : describe.skip

describe('profile formats', () => {
  it('a title implies a gender', () => {
    expect(['MR', 'mstr', 'MRS', 'MS', 'DR'].map(genderForTitle)).toEqual(['Male', 'Male', 'Female', 'Female', null])
  })
  it('dates convert between the picker and the airline format', () => {
    expect(toDateInput('07/03/1990')).toBe('1990-03-07')
    expect(fromDateInput('1990-03-07')).toBe('07/03/1990')
    expect(toDateInput('1990-03-07')).toBe('1990-03-07')
    expect(toDateInput('7/3/90')).toBe('')
  })
})

d('places', () => {
  let a: Actors

  beforeAll(async () => {
    await resetDatabase()
    a = await actors()
  })

  it('the pickers: every country, a country\'s states, and only for signed-in users', async () => {
    expect((await call(countriesGet, { url: '/api/reference/countries' })).status).toBe(401)
    const countries = (await call(countriesGet, { as: a.employee!, url: '/api/reference/countries' })).json as { countries: { code: string; name: string }[] }
    expect(countries.countries.length).toBeGreaterThan(240)
    expect(countries.countries).toContainEqual({ code: 'IN', name: 'India' })

    expect((await call(regionsGet, { as: a.employee!, url: '/api/reference/regions' })).status).toBe(400)
    const regions = (await call(regionsGet, { as: a.employee!, url: '/api/reference/regions?country=in' })).json as { regions: { name: string }[] }
    expect(regions.regions.map(r => r.name)).toEqual(expect.arrayContaining(['Maharashtra', 'Goa', 'Karnataka']))
  })

  it('countries become ISO codes; text typed before the picker converts', async () => {
    const res = await normalisePlaces(db, { nationality: 'Indian', issuingCountry: 'india', country: 'IND' })
    expect(res).toEqual({ ok: true, fields: { nationality: 'IN', issuingCountry: 'IN', country: 'IN' } })
    expect(await normalisePlaces(db, { nationality: 'Narnia' }))
      .toEqual({ ok: false, field: 'nationality', error: 'Nationality "Narnia" is not a country. Choose one from the list.' })
  })

  it('a state must belong to the country, and is stored under its own name', async () => {
    expect(await normalisePlaces(db, { state: 'maharashtra' })).toEqual({ ok: true, fields: { state: 'Maharashtra' } })
    expect(await normalisePlaces(db, { state: 'Teststate' }))
      .toEqual({ ok: false, field: 'state', error: '"Teststate" is not a state of India. Choose one from the list.' })
    // Bavaria is a state of Germany, not of India.
    expect((await normalisePlaces(db, { state: 'Bavaria' })).ok).toBe(false)
    expect((await normalisePlaces(db, { country: 'DE', state: 'Bavaria' })).ok).toBe(true)
  })

  it('cities: free text until the list is loaded, then checked within the state', async () => {
    expect(await normalisePlaces(db, { city: 'Anywhere' })).toEqual({ ok: true, fields: { city: 'Anywhere' } })
    const before = (await call(citiesGet, { as: a.employee!, url: '/api/reference/cities?country=IN&search=mum' })).json
    expect(before).toEqual({ ok: true, loaded: false, cities: [] })

    await exec(db, sql`
      insert into cities (id, country_code, region_code, name, ascii_name, population) values
        (1275339, 'IN', '16', 'Mumbai', 'Mumbai', 12691836),
        (1262319, 'IN', '16', 'Mumbra', 'Mumbra', 401000),
        (1275004, 'IN', '28', 'Kolkata', 'Kolkata', 4631392)`)

    const search = (await call(citiesGet, { as: a.employee!, url: '/api/reference/cities?country=IN&region=16&search=MUM' })).json as { loaded: boolean; cities: { name: string }[] }
    expect(search.loaded).toBe(true)
    expect(search.cities.map(c => c.name)).toEqual(['Mumbai', 'Mumbra'])

    expect(await normalisePlaces(db, { state: 'Maharashtra', city: 'mumbai' }))
      .toEqual({ ok: true, fields: { state: 'Maharashtra', city: 'Mumbai' } })
    expect(await normalisePlaces(db, { state: 'Maharashtra', city: 'Kolkata' }))
      .toEqual({ ok: false, field: 'city', error: '"Kolkata" was not found in Maharashtra. Choose one from the list.' })
    // Only the city changing: checked against the state already saved.
    expect((await normalisePlaces(db, { city: 'Kolkata' }, { state: 'Maharashtra' })).ok).toBe(false)
  })

  it('the TMC profile screen refuses a made-up place and stores the real one', async () => {
    const id = (await one<{ id: string }>(db, sql`
      select id from employees where client_id = ${a.corpAdmin.client_id} order by full_name, id limit 1`)).id
    const patch = (profile: Record<string, string>) =>
      call(profilePatch, { as: a.tmcAdmin, method: 'PATCH', url: `/api/tmc/traveler-profiles/${id}`, params: { id }, body: { profile } })

    expect(await patch({ nationality: 'Wakanda' })).toEqual({
      status: 422, json: { error: 'Nationality "Wakanda" is not a country. Choose one from the list.', field: 'nationality' },
    })
    expect((await patch({ nationality: 'Indian', state: 'maharashtra', city: 'MUMBAI' })).status).toBe(200)
    const saved = await one<{ p: Record<string, string> }>(db, sql`select traveler_profile as p from employees where id = ${id}`)
    expect(saved.p).toMatchObject({ nationality: 'IN', state: 'Maharashtra', city: 'Mumbai' })
  })
})
