# dwebmultifeed


Multifeed lets you group together a local set of ddatabases with
a remote set of ddatabases under a single shared identifier or key.

It solves the problem of [DDatabase](https://github.com/dwebprotocol/ddatabase)
only allowing one writer per ddatabase by making it easy to manage and sync
a collection of ddatabases -- by a variety of authors -- across peers.

Replication works by extending the regular ddatabase exchange mechanism to
include a meta-exchange, where peers share information about the feeds they
have locally, and choose which of the remote feeds they'd like to download in
exchange. Right now, the replication mechanism defaults to sharing all local
feeds and downloading all remote feeds.

This fork of multifeed removes storage of ddatabases from multifeed,
instead delegating / passing this on to [basestore](https://github.com/dwebprotocol/basestore).
Multifeed now caches each feed using its given public key
to ensure the correct feeds are shared on replication with remote peers.
Feeds keys are persisted in an additional local-only ddatabase
(it is not shared during replication), so that a multifeed instance can be easily recomposed
from our basestore, which holds no knowledge of which base belongs to which multifeed.

Using [basestore-networker](https://github.com/dwebprotocol/basestore-networker)
and the new multifeed networker, we can apply granular replication logic for
several multifeeds across a single instance of the [Hyperswarm DHT](https://github.com/dwebprotocol/dswarm).

## Usage

### Simple

```
var Multifeed = require('dwebmultifeed')
var ram = require('random-access-memory')

var multi = new Multifeed('./db', { valueEncoding: 'json' })

// a multifeed starts off empty
console.log(multi.feeds().length)             // => 0

// create as many writeable feeds as you want; returns ddatabases
multi.writer('local', function (err, w) {
  console.log(w.key, w.writeable, w.readable)   // => Buffer <0x..> true true
  console.log(multi.feeds().length)             // => 1

  // write data to any writeable feed, just like with ddatabase
  w.append('foo', function () {
    var m2 = multifeed(ddatabase, ram, { valueEncoding: 'json' })
    m2.writer('local', function (err, w2) {
      w2.append('bar', function () {
        replicate(multi, m2, function () {
          console.log(m2.feeds().length)        // => 2
          m2.feeds()[1].get(0, function (_, data) {
            console.log(data)                   // => foo
          })
          multi.feeds()[1].get(0, function (_, data) {
            console.log(data)                   // => bar
          })
        })
      })
    })
  })
})

function replicate (a, b, cb) {
  let pending = 2

  var r = a.replicate()

  r.pipe(b.replicate()).pipe(r)
    .once('error', cb)
    .once('remote-feeds', done)
    .once('remote-feeds', done)

  function done () {
    if (!--pending) return cb()
  }
}
```

### Complex

```
const Basestore = require('basestorex')
const SwarmNetworker = require('basestore-swarm-networking')
const Multifeed = require('dwebmultifeed')
const Networker = require('dwebmultifeed/networker')
const crypto = require('@ddatabase/crypto')

// create a new basestore for our ddatabases
const basestore = new Basestore(ram)

// initialize dswarm using basestore-swarm-networker and configure for multifeed
const network = new Networker(new SwarmNetworker(basestore))

// create two separate instances of multifeed for use across a single network swarm
const multi1 = new Multifeed(basestore, { key: crypto.randomBytes(32) })
const multi2 = new Multifeed(basestore, { key: crypto.randomBytes(32) })

// start replicating
network.swarm(multi1)
network.swarm(multi2)

// create a third instance which shares a key with the first
const multi3 = new Multifeed(basestore, { key: multi1.key })

// multi1 and multi3 will now replicate feeds
network.swarm(multi3)
```

For more information on how to implement replication across multiple multifeeds, see [test/new-basic.js](test/new-basic.js) for an example.

The main export (`new Multifeed(storage, opts)`) is API compatible with the original Multifeed as documented below. `storage` can also be a basestore (otherwise one is created with `storage`). Then connect it to a basestore swarm networker to apply multifeed replication.

## API

```js
var multifeed = require('dwebmultifeed')
```

### var multi = multifeed(storage[, opts])

Pass in a [random-access-storage](https://github.com/random-access-storage/random-access-storage) backend, and options. Included `opts` are passed into new ddatabases created, and are the same as [ddatabase](https://github.com/dwebprotocol/ddatabase#var-feed--hypercorestorage-key-options)'s.

Valid `opts` include:
- `opts.encryptionKey` (string): optional encryption key to use during replication. If not provided, a default insecure key will be used.
- `opts.ddatabase`: constructor of a ddatabase implementation. `ddatabase@10.x.x` is used from npm if not provided.

### multi.writer([name], [options], cb)

If no `name` is given, a new local writeable feed is created and returned via
`cb`.

If `name` is given and was created in the past on this local machine, it is
returned. Otherwise it is created. This is useful for managing multiple local
feeds, e.g.

```js
var main = multi.writer('main')        // created if doesn't exist
var content = multi.writer('content')  // created if doesn't exist

main === multi.writer('main')          // => true
```

`options` is an optional object which may contain: 
- `options.keypair` - an object with a custom keypair for the new writer.  This should have properties `keypair.publicKey` and `keypair.secretKey`, both of which should be buffers.

### var feeds = multi.feeds()

An array of all ddatabases in the multifeed. Check a feed's `key` to
find the one you want, or check its `writable` / `readable` properties.

Only populated once `multi.ready(fn)` is fired.

### var feed = multi.feed(key)

Fetch a feed by its key `key` (a `Buffer` or hex string).

### var stream = multi.replicate(isInitiator, [opts])

Create an encrypted duplex stream for replication.

Ensure that `isInitiator` to `true` to one side, and `false` on the other. This is necessary for setting up the encryption mechanism.

Works just like ddatabase, except *all* local ddatabases are exchanged between
replication endpoints.

### stream.on('remote-feeds', function () { ... })

Emitted when a new batch (1 or more) of remote feeds have begun to replicate with this multifeed instance.

This is useful for knowing when `multi.feeds()` contains the full set of feeds from the remote side.

### multi.on('feed', function (feed, name) { ... })

Emitted whenever a new feed is added, whether locally or remotely.

## multi.close(cb)

Close all file resources being held by the multifeed instance. `cb` is called once this is complete.

## multi.closed

`true` if `close()` was run successfully, falsey otherwise.

# Errors

The duplex stream returned by `.replicate()` can emit, in addition to regular
stream errors, two fatal errors specific to multifeed:

- `ERR_VERSION_MISMATCH`
  - `err.code = 'ERR_VERSION_MISMATCH'`
  - `err.usVersion = 'X.Y.Z'` (semver)
  - `err.themVersion = 'A.B.C'` (semver)

- `ERR_CLIENT_MISMATCH`
  - `err.code = 'ERR_CLIENT_MISMATCH'`
  - `err.usClient = 'MULTIFEED'`
  - `err.themClient = '???'`

## Install

With [npm](https://npmjs.org/) installed, run

```
$ npm install @frando/basestore-multifeed
```

## See Also

- [multifeed (original)](https://github.com/kappa-db/multifeed)
- [multifeed-index](https://github.com/kappa-db/multifeed-index)
- [ddatabase](https://github.com/dwebprotocol/ddatabase)
- [kappa-base](https://github.com/kappa-db/kappa-base)

## License

ISC
