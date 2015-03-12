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
	if (this.opts.disable) return next();
	var raja = this.raja;
	res.set('X-Raja', raja.opts.namespace);
	var url = req.protocol + "://" + req.get('Host') + req.url;
	var path = this.root + req.path;

	raja.retrieve(url, req, function(err, resource) {
		if (err) raja.error(err);
		if (!resource) resource = raja.create(url);
		var grace = false;
		if (!resource.valid && /\.min\.(css|js)/.test(url) && resource.data != null) {
			// this is a hack to work around current inability to rebuild minified files
			grace = true;
		}
		if (!resource.valid && !grace) {
			resource.depend(path);
			resource.save();
			raja.proxies.local.watch(path);
			return next();
		}
		for (var name in resource.headers) {
			var hval = resource.headers[name];
			if (hval) res.set(name, hval);
		}
		res.send(resource.data);
	});
}

