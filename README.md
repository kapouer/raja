raja - synchronized cache proxies for express-dom
=================================================

raja is a set of cache proxies tracking live resources changes and
relations, synchronized using a socket.io bus.

Core proxies are
- local or remote files
- static assets
- express http backends
- express-dom pages and resources

Each proxy can be setup separately - typically the http backend proxy can be
setup on a remote server, and each raja instance hosting proxies has its own
local, volatile, database for caching resources relations and data.

Likewise, the socket.io server can be spawned anywhere.


sample app.js
=============

```
var express = require('express');
var dom = require('express-dom');

var app = express();
var server = require('http').createServer(app);

app.set('views', process.cwd() + '/public');
app.set('statics', process.cwd() + '/public');

// start raja store, socket.io server, socket.io client
var raja = require('raja')({
	store: "sqlite://raja.db",
	// the application namespace, used in socket.io or http headers
	namespace: "test",
	// where socket.io clients must connect (namespace will be appended)
	client: "http://localhost:7000",
	// spawns a socket.io server
	server: server
}, function(err) {
	if (err) {
		console.error(err);
		process.exit(1);
	}
});

// raja proxy for express-dom
raja.proxies.dom(dom);

// it's possible to listen to all events using
raja.on('message', function(msg) {
	var lastUrl = msg.parents.slice(-1).pop() || msg.url;
	if (lastUrl == "someresource") // do something
});

// raja proxy for static assets
app.route(/^\/(css|img|js)\//).get(
	raja.proxies.static(app.get('statics')),
	express.static(app.get('statics'))
);

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({extended:true}));

app.route('/index').get(dom('index'));

// raja proxy for http backend
app.route('/rest/collection/:id?').all(
	raja.proxies.express().middleware,
	aRestCollectionMiddleware
);

// raja reverse proxy for remote resources
// this route will be invalidated when the child resource is invalidated
app.route('/rest/collection.rss').get(
	raja.proxies.express().middleware,
	function(req, res, next) {
		// the getResource function converts url into an absolute url
		// if it is given a remote url, it will watch it for changes
		req.getResource('.', function(err, str) {
			res.send(convertListToRSS(JSON.parse(str)));
		});
	}
);

server.listen(7000);
```

express-dom without raja
========================

Client-side development
-----------------------

index.html uses some index.js to request /rest/collection and merge returned
data into DOM.

express-dom
-----------

When a client requests "http://localhost:7000/index", this module spawns a DOM
into the server (using webkitgtk or else), and run index.html at the given url.

Once this page is idle (no pending requests, no repaints, no activity) it
is serialized and sent to the client.


resource tracking, cache synchronization with raja
==================================================

When a raja proxy is setup on express-dom, it tracks all resources used by the
first run of index.html, typically here it stores the fact that

http://localhost:7000/index depends on  
 http://localhost:7000/js/index.js  
 http://localhost:7000/rest/collection

it also stores the response html string, and it lets the spawned web page open
for a while.

The raja proxy that is setup on the rest http backend is here to broadcast
invalidation messages when any method other than GET is performed on that
resource.

The raja express-dom proxy is then informed that this resource url, used by
index.html, is invalidated, so it can mark it as so and next time a request is
made to GET index.html it will be rebuilt.

Similar invalidation messages are sent if index.html or index.js local files
change.

The whole cache is dropped when application is restarted - a simple way to
prevent having an invalid cache.

Inside an express middleware, one can fetch and declare a dependency on a
resource (external or inside the application) using

req.getResource(url, query, opts, cb)

where query is optional, and opts can set two options:

- poll : boolean, set to true if resource must be polled for changes until
  the moment it is flushed from the cache

- maxage : integer, seconds; default to 600 seconds.  
  invalidates a resource after `maxage` seconds.  

Combined with poll, maxage can ensure a resource is always up-to-date.


raja client
===========

The raja client exposes a simple function: `raja.on(url, listener)`

When this function is called the first time on a pristine index.html file,
the client will actually perform a XHR GET request to that url, and call
`listener(data, meta)`.

Just after that, it automatically connects to the socket.io server and join
the "http://localhost:7000/index" room - a room that receives all raja proxies
messages concerning resources upon which that web page depends.

If a resource change, the listener is responsible for taking appropriate action,
like merging further data, removing, modifying collection entries.

The fact that the web page is using the raja client to be kept synchronized
is also noticed by the raja express-dom proxy: in that case, instead of having
to rebuild index.html in the spawned DOM, it just has to serialize the page
that was kept living, since when the invalidation message is received the page
is already being updated live on the server.

The result of this approach is that we can transform any web page using the DOM
and javascript, a costly process, and be able to update build an up-to-date
copy of the html very quickly, without having to reload the page.

Typical figures:
* building a web page from scratch using express-dom and several http
	resources ~ 2 seconds
* getting a refreshed copy of a web page after modification of an http
	resource and reception of the raja synchronization message ~ 60 ms
* getting a copy from current cached instance ~ 6 ms


raja client utilities
=====================

* raja.METHOD(url, <query>, <body>, cb) where METHOD is GET, PUT, POST, DELETE.  
  A xhr wrapper, returns json or text, cb(err, objOrText), err.code contains status.

* raja.urlQuery(url, query) to append query parameters (given as hash array) to a url

* raja.loadScript(url, cb) to insert a script in the document (but not let it
appear in the html afterwise)

* raja.absolute(baseUrl, relativeUrl) converts a url (with ./ or ../) relative
a base url into an absolute one.


live updates and the idempotency rule
=====================================

Since the web page is built once "out of nothing" on the server, serialized,
then sent to the client, and can receive synchronization messages there,
it is important to make sure the code merging data into the DOM can be
idempotent.

See http://github.com/kapouer/domt for such a library.


synchronization messages format
===============================

See also doc/REST.md.

```json
{
	url: <identifying the resource that was first modified>,
	data: <optional data that describes the modification of that resource>,
	mtime: <last-modified of the resource>,
	method: <the rest method applied to the resource>,
	parents: [url1_using_url, url2_using_url1, ...]
}
```

Raja populates the parents list whenever a parent is found.
It can be initially filled - it typically happens when acting upon an element
of a collection, in which case the first url in the list is the url of the
collection.

