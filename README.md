raja - synchronized cached proxies for express-dom
==================================================

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
	io: {
		uri: "http://localhost:7000", // the uri the client connects to
		server: server								// spawns a socket.io server on it
	}
}, function(err) {
	if (err) {
		console.error(err);
		process.exit(1);
	}
});

// raja proxy for express-dom
raja.proxies.dom(dom);

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


live updates and the idempotency rule
=====================================

Since the web page is built once "out of nothing" on the server, serialized,
then sent to the client, and can receive synchronization messages there,
it is important to make sure the code merging data into the DOM can be
idempotent.

See http://github.com/kapouer/domt for such a library.


synchronization messages format
===============================

```json
{
	src: <the initial resource that was modified>,
	url: <the last invalidated resource>,
	room: <the target resource being invalidated - typically the web page url>,
	mtime: <last-modified of the resource>,
	method: <the semantic http method representing what's happening to url>,
	data: <an optional body representing the modification described by method>
}
```

url is mandatory, room is optional and is equal to url if empty,
src is optional and equal to url if empty.

mtime is mandatory

method is optional, defaults to "put", can be also "post" or "delete"

data is optional, actually only provided by the express proxy upon a "post" or
"put" resource modification.

