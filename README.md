raja - synchronized cache proxies for express-dom
=================================================

Raja is a set of proxies, middlewares, working with
express, express-dom, or with any remote http resources,
designed to cache and render DOM using javascript inside a real
client (webkitgtk for now) and trace the dependencies tree
for changes, propagate those changes using socket.io, so it can
keep all caches of resources in sync.

A typical web page developed with raja does not have to use
any of its client API - only if wants to benefit from live updates,
and even there it could directly connect to using socket.io client.

raja is *agnostic* in its design - any server-side DOM rendering could
in principle be done on top of it.


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
	server: server,
	// install optional statics proxy - needed when using minify plugin
	statics: app.get('statics'),
	// install optional express-dom proxy
	dom: dom
}, function(err) {
	if (err) {
		console.error(err);
		process.exit(1);
	}
});

/* minification and automatic edition of script, link tags
 that have the "minify" attribute
 <script minify src="jquery.js"></script> <!-- minifies to jquery.min.js -->
 <script minify="lib.js" src="file1.js"></script>
 <script minify="lib.js" src="file2.js"></script> <!-- concatenate and minify -->
 will result in
 <script src="jquery.min.js"></script>
 <script src="lib.js"></script>
 and changes in dependencies are propagated with the help of raja infrastructure
*/

dom.author(raja.plugins.minify);

// it's possible to listen to all events using
raja.on('message', function(msg) {
	var lastUrl = msg.parents.slice(-1).pop() || msg.url;
	if (lastUrl == "someresource") // do something
});

// raja proxy for static assets
app.route(/^\/(css|img|js)\//).get(
	raja.proxies.statics,
	express.static(app.get('statics'))
);

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({extended:true}));

app.route('/index').get(dom('index'));

// raja proxy for http backend
app.route('/rest/collection/:id?').all(
	raja.proxies.express.middleware,
	aRestCollectionMiddleware
);

// raja reverse proxy for remote resources
// this route will be invalidated when the child resource is invalidated
app.route('/rest/collection.rss').get(
	raja.proxies.express.middleware,
	function(req, res, next) {
		// req.resource represents the requested url
		// and exposes a 'load' method that uses remote proxy
		// and is tracked by express proxy to cache resources
		// and their dependencies - the remote proxy has maxage
		// and preload support in such a way it can update
		// without blocking
		req.resource.load('/rest/collection', function(err, str) {
			res.send(convertJSONToRSS(JSON.parse(str)));
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

Server-side rendering by express-dom
------------------------------------

When a client requests "http://localhost:7000/index", this express middleware
spawns a web page into the server (using webkitgtk or else), and load index.html
in it as if it was on a real client browser - at the requested url.

Once this page is idle (no pending requests, no repaints, no long timeouts, no activity)
it is serialized and sent to the client.


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
prevent having an invalid cache (in a future version the cache will stay around,
and be invalidated instead of cleaned).

Inside an express middleware, one can fetch and declare a dependency on a
resource (external or inside the application) using

req.resource.load(url, query, opts, cb)

where query is optional, and opts can set two options:

- preload : boolean, set to true if resource must be polled for changes until
  the moment it is flushed from the cache. Otherwise the resource is loaded
  on demand after is it invalidated.

- maxage : integer, seconds; default to 600 seconds.  
  invalidates a resource after `maxage` seconds.  

Combined with preload, maxage can ensure a resource is always up-to-date,
and has the effect of always immediately sending the cached version without delay.


authentication - authorization
==============================

Authentication is done as usual (some rights are given to a session and those
rights are checked whenever access must be granted), with additional information
sent through specific HTTP headers:
Rights that are needed to access a given url must be listed in
the X-Right HTTP request header.

It implicitely sets X-Grant: <rights> and Vary: X-Grant response headers,
which are used to cache resource properly.

For now it doesn't set them explicitely - that might happen in the future;
for instance it could be used to make sure actual grants for resources consumed
by a page match requested rights.


content negotiation
===================

If a resource vary on Content-Type, it is expected to always provide an
Accept request header - as there is no way to tell which variant is the right
one without it.
For now, only the first accepted variant is actually searched, so if request
accepts json, xml and the cache has only one resource for the xml variant,
it won't be found.

Authorization negotiation works on the same model - only 'exact' matching is
currently supported in both types of negotiation.


raja client
===========

The raja client exposes a simple function: `raja.on(url, listener)`

When this function is called the first time on a pristine index.html file,
the client will actually perform a XHR GET request to that url, and call
`listener(data, meta)`.

Just after that, it automatically connects to the socket.io server and join
the "http://localhost:7000/index.html" room - a room that receives all raja proxies
messages concerning resources upon which that web page at that url depends.

For example it receives messages about static js, css file changes, minified versions
changes, HTTP resources changes (if they are proxied by raja), html changes,
or even changes made by javascript code running live on that page.

If a resource change, the listener is responsible for taking appropriate action,
like merging further data, removing, modifying collection entries.

The fact that the web page is using the raja client to be kept synchronized
is also noticed by the raja express-dom proxy: in that case, instead of having
to rebuild index.html in the spawned DOM, it just has to serialize the page
that was kept living, since when the invalidation message is received the page
is already being updated live on the server.

The result of this approach is that we can transform any web page using the DOM
and javascript, a costly process, and be able to build an up-to-date
copy of the html very quickly, without having to reload the page.

Typical figures:
* building a web page from scratch using express-dom and several http
  resources ~ 1 second on first launch (even modules are not all yet
  all loaded)   
* getting a refreshed copy of a web page after modification of an http
  resource and reception of the raja synchronization message ~ 50 ms
* getting a copy from current cached instance ~ 6 ms


raja client utilities
=====================

* raja.on(url, <query>, listener)

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

Isomorphic frameworks willing to support server-side rendering all follow
more or less that same basic principle.

A very simple, dirty but funny to use implementation of an idempotent
DOM merging tool is http://github.com/kapouer/domt (well tested and maintained).


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

Raja populates the parents list whenever a parent is found in the relations stored
in the caches of its various proxies.
It can be initially filled - it typically happens when acting upon an element
of a collection, in which case the first url in the list is the url of the
collection, see doc/.
