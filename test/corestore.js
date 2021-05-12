const test = require('tape')
const crypto = require('@ddatabase/crypto')
const dswarm = require('dswarm')
const ram = require('random-access-memory')

const { create, cleanup, BOOTSTRAP_PORT } = require('./lib/networker')

const MultifeedNetworker = require('../networker')
const multifeed = require('..')

const KEY_A = Buffer.alloc(32, 1)
const KEY_B = Buffer.alloc(32, 2)

test('basestore networker example', async function (t) {
  // Create two distinct corestores and networkers.
  // They will communicate over a localhost DHT.
  const { store: store1, networker: networker1 } = await create()
  const { store: store2, networker: networker2 } = await create()

  // Init some bases.
  const base1 = store1.get()
  const base2a = store2.get()
  const base2b = store2.get()

  await append(base1, 'hello')
  const data = await get(base1, 0)
  t.same(data, Buffer.from('hello'))

  // For each networker, setup the mulitfeed mux wrapper.
  const muxer1 = new MultifeedNetworker(networker1)
  const muxer2 = new MultifeedNetworker(networker2)

  // For each mux wrapper, join on two different multifeed rootkeys.
  const mux1a = muxer1.join(KEY_A, { name: 'm1a' })
  const mux1b = muxer1.join(KEY_B, { name: 'm1b' })

  const mux2a = muxer2.join(KEY_A, { name: 'mux2a' })
  const mux2b = muxer2.join(KEY_B, { name: 'mux2b' })

  // Person 1 adds the same feed to both multifeeds.
  mux1a.addFeed(base1)
  mux1b.addFeed(base1)

  // Person2 adds two different feeds to each multifeed.
  mux2a.addFeed(base2a)
  mux2b.addFeed(base2b)

  // Wait for things to sync.
  // TODO: Remove timeout, wait for event instead.
  await timeout(500)

  // Check that the muxers for the same keys arrived at the same set of feeds.
  t.deepEqual(toKeys(mux1a.feeds()), toKeys([base1, base2a]))
  t.deepEqual(toKeys(mux2a.feeds()), toKeys([base1, base2a]))
  t.deepEqual(toKeys(mux1b.feeds()), toKeys([base1, base2b]))
  t.deepEqual(toKeys(mux2b.feeds()), toKeys([base1, base2b]))

  // Check that the bases actually replicated.
  let checked = false
  for (const feed of mux2b.feeds()) {
    if (feed.key.toString('hex') === base1.key.toString('hex')) {
      const data = await get(store2.get(base1.key), 0)
      t.same(data, Buffer.from('hello'))
      checked = true
    }
  }
  if (!checked) t.fail('missing data check')

  // Cleanup.
  await cleanup([networker1, networker2])
  t.end()
})

test('basestore to multifeed over dswarm', async t => {
  const muxkey = KEY_A

  // setup a basestore muxer
  const { store, networker } = await create()
  const base = store.get()
  const muxer = new MultifeedNetworker(networker)
  const mux = muxer.join(muxkey)
  mux.addFeed(base)

  // setup a multifeed muxer plus network
  const multi = multifeed(ram, { encryptionKey: muxkey })
  let multifeedWriter
  await new Promise(resolve => {
    multi.writer('local', (err, feed) => {
      multifeedWriter = feed
      t.error(err)
      feed.append('hello', resolve)
    })
  })
  const swarm2 = dswarm({
    bootstrap: `localhost:${BOOTSTRAP_PORT}`
  })
  swarm2.join(crypto.discoveryKey(muxkey), { announce: true, lookup: true })
  let didConnect = false
  // Just pipe all connections directly into the multifeed replication stream.
  // This is what e.g. cabal currently does, and would need a seperate dswarm
  // instance to replicate multiple multifeeds in parallel (before this patch).
  swarm2.on('connection', (socket, details) => {
    if (didConnect) return
    didConnect = true
    const isInitiator = !!details.client
    const stream = multi.replicate(isInitiator, { live: true })
    stream.pipe(socket).pipe(stream)
  })

  // wait and see
  await timeout(500)
  t.deepEqual(toKeys(multi.feeds()), toKeys([multifeedWriter, base]))
  t.deepEqual(toKeys(mux.feeds()), toKeys([multifeedWriter, base]))
  swarm2.destroy()
  await cleanup([networker])
})

function toKeys (feeds) {
  return feeds.map(f => f.key.toString('hex')).sort()
}

function append (base, data) {
  return new Promise((resolve, reject) => {
    base.append(data, err => {
      if (err) return reject(err)
      return resolve()
    })
  })
}
function get (base, idx, opts = {}) {
  return new Promise((resolve, reject) => {
    base.get(idx, opts, (err, data) => {
      if (err) return reject(err)
      return resolve(data)
    })
  })
}

function timeout (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
