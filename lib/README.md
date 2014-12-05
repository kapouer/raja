raja is in several parts

# front

initialize DB
init express plugin
init dom plugin


# back

init express plugin
notifications: not necessarily done using messages
advantage: front clients can subscribe too


The express plugin is the same on back or on front, it hooks on express routes,
identifies requested URL, record in cache or reply cached object to response,
and send notifications when any other method than GET is used upon that URL.
But:
	- on a web page URL, almost only GET requests are done, so the express plugin
rarely send a notification upon such change, but cache is invalidated often
because dependencies are invalidated
	- on a resource URL, notifications are often sent, but cache is almost never
invalidated because of dependencies


Invalidation notifications are consumable by web clients, as well as raja-core.

Distributed cache

* all resources are cached locally
* dependencies lists needed by a resource are stored locally
* all caches must receives all notifications and each cache must check
  it has parent url depending on the changed url or not, in which case it must
  invalidate that parent url
* same applies for web pages

it is nicer because it is a symmetric cache setup, and uses messaging symmetrically.
it could also be used for efficient load-balancing of a big web site.
Less nice, each cache instance ends up having to be maintained - updated,
setup, etc...

What does this mean for the implementation ?

Access to DB is entirely internal - no HTTP API for it.
DB should be portable - better use sqlite3
Messages are exchanged between caches using any pub/sub server.

How do live updates of express-dom instances is dealt with ?
0) a resource is changed by a PUT to it
1) the raja instance resource plugin
   + marks that resource cache entry as invalid if it uses raja store to cache its own data
   + sends a message to every raja instances (even self)
2) the raja instance managing the web page receives that message (not the plugin, mind you)
2bis) if that instance has that page alive in the pool, it receives the message as well
    (because it already is subscribed to that resource url, since it depends on it)
    and starts updating the page at once
3) raja instance checks the store has an url that depends on the changed resource
4) it marks the cache entry as invalid
5) it GETs the web page url - no it doesn't - or else we end up with regenerating lots of stuff
6) the dom plugin
   + if the web page is loaded in the pool, it waits next idle event to get its html and refresh the cache
   + if it is not, it doesn't do anything and wait for next request to refresh the cache
   + updates the cache entry marking it as valid as soon as the cache is refreshed



About Raja Store
================

It is meant to be a two-level cache (memory and disk cache).
If the cache loses information (by crash) it should just be invalidated so that
resources are reloaded.



# setup

in every application where a cache is setup:

1) initialize db

2) initialize connection to pub/sub

3) initialize plugin

4) initialize app, of course


Simplified setup - less distributed and easier to run

* since the web pages are what we want to serve, the "main" application can
also be used to run the pub/sub server.

* for small webapps, the REST backends are actually run inside the main app as
well !

* Db and pub/sub are setup only once. Db can be shared with main app db as
well.


 
