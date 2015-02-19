var q = require('queue-async');
var events = require('events');
var util = require('util');
var URL = require('url');

// initialize io, store
// invalid cache upon message reception

module.exports = function(opts, cb) {
	var raja = new Raja(opts);
	raja.error = Raja.prototype.error.bind(raja);

	raja.proxies = {};

	raja.proxies.local = require('./proxies/local')(raja, opts);
	raja.proxies.remote = require('./proxies/remote')(raja, opts);
	raja.proxies.express = require('./proxies/express')(raja, opts);
	raja.proxies.statics = opts.statics && require('./proxies/statics')(raja, opts);
	raja.proxies.dom = opts.dom && require('./proxies/dom')(raja, opts);

	raja.init(function(err) {
		cb(err, raja);
	});
	return raja;
};

function Raja(opts) {
	this.opts = opts || {};
	if (!this.opts.namespace) {
		this.opts.namespace = "";
		console.info("Raja expects a namespace, using empty string");
	}
	if (this.opts.client) this.opts.client += '/' + this.opts.namespace;
}
util.inherits(Raja, events.EventEmitter);

Raja.prototype.init = function(cb) {
	q(2)
	.defer(require('./io'), this, this.opts)
	.defer(require('./store'), this, this.opts)
	.await(function(err, io, store) {
		if (err) return cb(err);
		if (this.opts.client && !io) return cb(new Error("raja failed to init io"));
		if (!store) return cb(new Error("raja failed to init store"));
		this.io = io;
		this.store = store;
		this.emit('ready');
		cb(null, this);
	}.bind(this));
};

// internal function
Raja.prototype.receive = function(msg) {
	if (!msg.url) return;
	if (!msg.parents) msg.parents = [];
	if (msg.mtime) msg.mtime = new Date(msg.mtime);
	this.emit('message', msg);
	this.store.invalidateParents(msg, function(err) {
		if (err) console.error(err);
	});
};

Raja.prototype.send = function(msg) {
	if (!msg.url) {
		return this.error(new Error("missing msg.url in " + msg));
	}
	if (!msg.mtime) msg.mtime = Date.now();
	else if (msg.mtime instanceof Date) msg.mtime = msg.mtime.getTime();
	this.io.send(msg);
};

Raja.prototype.error = function(err) {
	// called when an error happened while using raja
	if (err) console.error(err);
};

Raja.prototype.shallow = shallow;

Raja.prototype.wrap = function(obj) {
	if (!Object.prototype.hasOwnProperty.call(obj, 'load')) {
		Object.defineProperty(obj, 'load', {
			enumerable: false,
			value: loadResource.bind(this, obj)
		});
	}
	if (!Object.prototype.hasOwnProperty.call(obj, 'save')) {
		Object.defineProperty(obj, 'save', {
			enumerable: false,
			value: this.store.set.bind(this.store, obj.key || obj.url, obj)
		});
	}
	return obj;
};

Raja.prototype.create = function(url, vary) {
	return this.wrap({key: this.store.key(url, vary), url: url});
};

function shallow(src, dst) {
	dst = dst || {};
	for (var key in src) {
		dst[key] = src[key];
	}
	return dst;
}

function loadResource(resource, remote, query, opts, cb) {
	if (!resource.resources) resource.resources = {};
	if (!cb && !opts && typeof query == "function") {
		cb = query;
		opts = null;
		query = null;
	} else if (!cb && typeof opts == "function") {
		cb = opts;
		opts = null;
	}
	if (query) {
		remote = urlParams(remote, query);
		remote = urlQuery(remote, query);
	}
	if (!/^https?:/.test(remote)) remote = absolute(URL.parse(resource.url), remote);
	this.proxies.remote.get(remote, opts, function(err, res) {
		if (err >= 400 && err < 500) {
			delete resource.resources[remote];
		} else if (!err) {
			resource.resources[remote] = res && res.headers && res.headers['Content-Type'] || true;
		}
		cb(err, res && res.data);
	}.bind(this));
}

function absolute(loc, url) {
	if (/^https?/i.test(url)) return url;
	var path = loc.pathname;
	if (url.indexOf('..') == 0) {
		path = path.split('/');
		path.pop();
		url = path.join('/') + url.substring(2);
	} else if (url == '.') {
		return loc.href;
	} else if (url.indexOf('.') == 0) {
		url = path + url.substring(1);
	} else if (url.indexOf('/') != 0) {
		var base = path.split('/');
		base.pop();
		base = base.join('/');
		url = base + '/' + url;
	}
	url = loc.protocol + '//' + loc.host + url;
	return url;
}

function urlParams(url, params) {
	if (!params) return url;
	return url.replace(/\/:(\w+)/g, function(str, name) {
		var val = params[name];
		if (val != null) {
			delete params[name];
			return '/' + val;
		} else {
			return '/:' + name;
		}
	});
}

function urlQuery(url, query) {
	if (!query) return url;
	var comps = [];
	var str;
	for (var k in query) {
		str = encodeURIComponent(k);
		if (query[k] != null) str += '=' + encodeURIComponent(query[k]);
		comps.push(str);
	}
	if (comps.length) {
		if (url.indexOf('?') > 0) url += '&';
		else url += '?';
		url += comps.join('&');
	}
	return url;
}

