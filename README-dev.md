Development notes about raja
============================

Common mistakes
---------------

* This ruins the order with which tasks where queued:  
  `q().defer(function(cb) { async(cb); })`

* This hangs response if caching mecanism kicks in:
  `CacheOnDemand(function(res, cb) { res.send(); cb(); })`
  the problem is that dom plugins receive res, and it's very easy to
  stumble upon that problem. Currently no plugin actually need res,
  `dom.use(plugin(inst){})` is enough (it has all necessary info) ?
  Change it in express-dom ?


