var Path = require('path');
var debug = require('debug')('raja:statics');

module.exports = function(raja, opts) {
	var inst = new StaticProxy(raja, opts);
	return inst.middleware.bind(inst);
};

function StaticProxy(raja, opts) {
	if (!(this instanceof StaticProxy)) return new StaticProxy(raja, opts);
	this.raja = raja;
	this.opts = opts;
	this.root = Path.resolve(opts.statics);
}

StaticProxy.prototype.middleware = function(req, res, next) {
	if (this.opts.disable) return next();
	var raja = this.raja;
	res.set('X-Raja', raja.opts.namespace);
	var url = req.protocol + "://" + req.get('Host') + req.url;
	var path = this.root + req.path;
	var headers = raja.headers(req);
	headers['X-Raja'] = raja.opts.namespace;

	raja.retrieve(url, headers, function(err, resource) {
		if (err) raja.error(err);
		if (!resource) {
			debug('create', url);
			resource = raja.create({url: url, builder: 'statics'}, res);
		}
		if (!resource.valid) {
			if (resource.builder && raja.builders[resource.builder]) {
				debug('builder', resource.key);
				raja.builders[resource.builder](resource, function(err) {
					if (err) return next(err);
					send(res, resource);
				});
			} else {
				debug('save', resource.key);
				resource.depend({url:path, builder: 'local'});
				resource.save();
				raja.proxies.local.watch(path);
				return next();
			}
		} else {
			send(res, resource);
		}
	});
};

function send(res, resource) {
	for (var name in resource.headers) {
		var hval = resource.headers[name];
		if (hval) res.set(name, hval);
	}
	res.send(resource.data);
}

