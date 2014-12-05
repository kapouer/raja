These files are proxies taking care of returning cached resources,
updating dependency status of resources, and notifying when a
resource has changed (as far as each plugin can tell).

* dom - hooks into express-dom
* express - hooks into express (and connect ?) as a middleware
* local - fetch and watch local files
* remote - fetch and poll remote http files (using http cache headers)

All these plugins must have access to a raja instance (io + store).

raja.store must be used to store / retrieve cached data - including the list
of url needed by that data to be built.
raja.io must be used to send / receive synchronization messages.

require('raja-dom')(raja, dom);
require('raja-express')(raja, app);

Those two are usually tools for dom and express.
var local = require('raja-local')(raja);
var remote = require('raja-remote')(raja);

