var q = require('queue-async');
var events = require('events');
var util = require('util');
var URL = require('url');
var qs = require('querystring');
var type = require('type-is');
var bufferEqual = require('buffer-equal');
var agent = require('./utils/agent');

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

module.exports.agent = agent;

function Raja(opts) {
	this.opts = opts || {};
	if (!this.opts.namespace) {
		this.opts.namespace = "";
		console.info("Raja expects a namespace, using empty string");
	}
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

Raja.prototype.dataEqual = dataEqual;

Raja.prototype.create = function(obj, havingHeaders) {
	if (typeof obj == "string") obj = {url: obj};
	var props = {};
	for (var key in obj) props[key] = {
		value: obj[key],
		enumerable: true,
		writable: true
	};
	var inst = Object.create(Resource.prototype, props);
	if (havingHeaders) inst.headers = this.headers(havingHeaders);
	Object.defineProperty(inst, 'raja', {
		enumerable: false,
		value: this
	});
	return inst;
};

Raja.prototype.retrieve = function(url, havingHeaders, cb) {
	if (!cb && typeof havingHeaders == "function") {
		cb = havingHeaders;
		havingHeaders = null;
	}
	var key = havingHeaders ? this.key(url, this.variant(this.headers(havingHeaders))) : url;
	this.store.get(key, cb);
};

function Resource() { /* initialization code will not be called by Object.create */ }

Resource.prototype.depend = function(resource) {
	if (!this.resources) this.resources = {};
	if (!(resource instanceof Resource)) {
		if (typeof resource == "string") resource = {url: resource};
		resource = this.raja.create(resource);
	}
	resource.key = this.raja.key(resource.url, this.raja.vary(resource.headers));
	this.resources[resource.key] = resource;
};

Resource.prototype.undepend = function(resource) {
	if (!this.resources || !resource) return;
	var key;
	if (typeof resource == "string") key = resource;
	else key = this.raja.key(resource.url, this.raja.vary(resource));
	delete this.resources[key];
};

Resource.prototype.save = function() {
	var raja = this.raja;
	if (!this.url) {
		if (this.key) {
			this.url = keyToObj(this.key).url;
		} else {
			throw new Error("Resource has no key, no url " + JSON.stringify(this));
		}
	}

	if (!this.key) this.key = raja.key(this.url, raja.vary(this.headers));
	raja.store.set(this.key, this);
	return this;
};

Resource.prototype.load = function(remote, query, opts, cb) {
	if (!this.resources) this.resources = {};
	if (!cb && !opts && typeof query == "function") {
		cb = query;
		opts = null;
		query = null;
	} else if (!cb && typeof opts == "function") {
		cb = opts;
		opts = null;
	}
	if (query) {
		remote = agent.substitute(remote, query);
		remote = agent.append(remote, query);
	}
	if (!/^https?:/.test(remote)) remote = agent.resolve(URL.parse(this.url), remote);
	this.raja.proxies.remote.get(remote, opts, function(err, resource) {
		if (err >= 400 && err < 500) {
			this.undepend(resource);
		} else if (!err) {
			this.depend(resource);
		}
		cb(err, resource && resource.data);
	}.bind(this));
};


Resource.prototype.invalidate = function(cb) {
	this.raja.store.invalidate(this.key, cb);
};

Raja.prototype.headers = function(havingHeaders) {
	if (!havingHeaders) return;
	var obj = {};
	var headers = havingHeaders.headers;
	var hasGet = !!havingHeaders.get;
	if (!headers && !hasGet) headers = havingHeaders;
	['Content-Type', 'Vary', 'ETag', 'Accept'].forEach(function(name) {
		var iname = name.toLowerCase();
		var val = headers && (headers[iname] || headers[name]) || hasGet && havingHeaders.get(iname);
		if (val) obj[name] = val;
	});
	return obj;
};

Raja.prototype.vary = function(headers) {
	if (!headers) return;
	var vary = {};
	if (!headers.Vary) return vary;
	headers.Vary.split(',').forEach(function(header) {
		header = header.trim();
		var val = headers[header];
		if (header == 'Content-Type') {
			// support only json type as variant for now
			if (type.is(val, 'json')) vary.type = 'json';
		}
	});
	return vary;
};

Raja.prototype.variant = function(headers) {
	if (!headers) return;
	if (type.is(headers['Accept'], 'json')) return {type: 'json'};
};

Raja.prototype.key = function(url, obj) {
	if (!obj) return url;
	for (var k in obj) if (obj[k] == null) delete obj[k];
	var str = obj && qs.stringify(obj);
	if (str) url = str + ' ' + url;
	return url;
};

function shallow(src, dst) {
	dst = dst || {};
	for (var key in src) {
		dst[key] = src[key];
	}
	return dst;
}

function keyToObj(key) {
	var obj;
	var find = /^(.*\s)?(https?:\/\/.+)$/.exec(key);
	if (find != null && find.length == 3) {
		var query = find[1];
		if (query) {
			obj = qs.parse(query);
		} else {
			obj = {};
		}
		obj.url = find[2];
	} else {
		obj = {url: key};
	}
	return obj;
}

function dataEqual(a, b) {
	var bufa = Buffer.isBuffer(a);
	var bufb = Buffer.isBuffer(b);
	if (!bufa && !bufb) return a === b;
	if (!bufa) a = new Buffer(a);
	if (!bufb) b = new Buffer(b);
	return bufferEqual(a, b);
}

