var fs = require('fs');
var Path = require('path');
var q = require('queue-async');

module.exports = function(raja, opts) {
	var inst = new StaticProxy(raja, opts.statics);
	return inst.middleware.bind(inst);
};

function StaticProxy(raja, root) {
	if (!(this instanceof StaticProxy)) return new StaticProxy(raja);
	this.raja = raja;
	this.root = Path.resolve(root);
}

StaticProxy.prototype.middleware = function(req, res, next) {
	var raja = this.raja;
	res.set('X-Raja', raja.opts.namespace);
	var url = req.protocol + "://" + req.get('Host') + req.url;
	var path = this.root + req.path;

	raja.store.get(url, function(err, resource) {
		if (err || !resource || !resource.valid) {
			return thenSave();
		}
		for (var name in resource.headers) {
			var hval = resource.headers[name];
			if (hval) res.set(name, hval);
		}
		res.send(resource.data);
	});

	function thenSave() {
		raja.store.set(url, {
			resources: [path]
		}, function(err, resource) {
			if (err) {
				raja.error(err);
			} else {
				// watch path
				raja.proxies.local.watch(path);
			}
			next();
		});
	}
}

