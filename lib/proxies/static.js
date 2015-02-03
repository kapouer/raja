var fs = require('fs');
var Path = require('path');
var q = require('queue-async');

module.exports = function(raja, root) {
	var inst = new StaticProxy(raja, root);
	return inst.middleware.bind(inst);
};

function StaticProxy(raja, root) {
	if (!(this instanceof StaticProxy)) return new StaticProxy(raja);
	this.raja = raja;
	this.local = raja.proxies.local();
	this.root = Path.resolve(root);
}

StaticProxy.prototype.middleware = function(req, res, next) {
	res.set('X-Raja', this.raja.opts.namespace);
	var url = req.protocol + "://" + req.get('Host') + req.url;
	var path = this.root + req.path;

	this.raja.store.set(url, {
		resources: [path]
	}, function(err, resource) {
		if (err) {
			this.raja.error(err);
		} else {
			// watch path
			this.local.watch(path);
		}
		next();
	}.bind(this));
}

