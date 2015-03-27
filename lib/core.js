var queue = require('queue-async');
var events = require('events');
var util = require('util');
var URL = require('url');
var qs = require('querystring');
var typeis = require('type-is').is;
var bufferEqual = require('buffer-equal');
var agent = require('./utils/agent');
var Comb = require('js-combinatorics').Combinatorics;

module.exports = function(opts, cb) {
	var raja = new Raja(opts);
	raja.error = Raja.prototype.error.bind(raja);
	raja.agent = agent;

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
	queue(2)
	.defer(require('./io'), this, this.opts)
	.defer(require('./store'), this, this.opts)
	.await(function(err, io, store) {
		if (err) return cb(err);
		if (this.opts.client && !io) return cb(new Error("raja failed to init io"));
		if (!store) return cb(new Error("raja failed to init store"));
		this.io = io;
		this.store = store;
		this.session = require('./store/session').bind(null, raja);
		this.emit('ready');
		cb(null, this);
	}.bind(this));
};

// internal function
Raja.prototype.receive = function(msg) {
	if (!msg.key && !msg.url) return;
	if (!msg.parents) msg.parents = [];
	if (msg.mtime) msg.mtime = new Date(msg.mtime);
	this.emit('message', msg);
	this.store.invalidateParents(msg, function(err) {
		if (err) console.error(err);
	});
};

Raja.prototype.send = function(msg) {
	if (!msg.key && !msg.url) {
		return this.error(new Error("Missing key in " + JSON.stringify(msg)));
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
	for (var key in obj) if (key != 'id' && key != 'children') props[key] = {
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
	var keys = havingHeaders ? this.keys(url, this.variant(this.headers(havingHeaders))) : [url];
	var tryGet = function() {
		var key = keys.shift();
		if (!key) return cb();
		this.store.get(key, function(err, obj) {
			if (err || obj) return cb(err, obj);
			tryGet();
		});
	}.bind(this);
	tryGet();
};

Raja.prototype.upsert = function(obj, cb) {
	this.retrieve(obj.url, obj, function(err, resource) {
		if (err) return cb(err);
		if (!resource) {
			resource = this.create(obj);
		} else {
			raja.shallow(obj, resource);
			resource.headers = this.headers(resource);
		}
		resource.save(cb);
	}.bind(this));
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
	else key = this.raja.key(resource.url, this.raja.vary(resource.headers));
	delete this.resources[key];
};

Resource.prototype.save = function() {
	var raja = this.raja;
	if (!this.url) {
		if (this.key) {
			this.url = keyObj(this.key).url;
		} else {
			throw new Error("Missing key in " + JSON.stringify(this));
		}
	}
	var key = raja.key(this.url, raja.vary(this.headers));
	if (!this.key) {
		this.key = key;
	} else if (this.key != key) {
		return this.copy(key);
	}
	raja.store.set(this.key, this);
	return this;
};

Resource.prototype.copy = function(newkey) {
	var raja = this.raja;
	var copy = raja.create(this);
	copy.key = newkey;
	// save calls store.set, which in turn ties resources and parents to this copy
	copy.save();
	return copy;
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
	remote = agent.resolve(this.url, remote);
	this.raja.proxies.remote.get(remote, query, opts, function(err, resource) {
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
	if (!havingHeaders) return {};
	var obj = {};
	var headers = havingHeaders.headers;
	var hasGet = !!havingHeaders.get;
	if (!headers && !hasGet) headers = havingHeaders;
	['Content-Type', 'Vary', 'ETag', 'Accept', 'X-Grant', 'X-Right'].forEach(function(name) {
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
			var type = typeis(val, ['json', 'html']);
			if (type == 'json') vary.type = type; // store html as default
		} else if (header == 'X-Grant') {
			vary.right = val;
		}
	});
	return vary;
};

Raja.prototype.variant = function(headers) {
	if (!headers) return;
	var obj = {};
	var accept = headers['Accept'];
	if (accept) {
		var type = typeis(accept, ['json', 'html']);
		if (type == 'json') obj.type = type; // no type means default type
	}
	var right = headers['X-Right'];
	if (right) {
		obj.right = right.split(',').map(function(str) {return str.trim();}).sort();
	}
	return obj;
};

Raja.prototype.key = function(url, obj) {
	if (!obj) return url;
	for (var k in obj) if (obj[k] == null) delete obj[k];
	var str = obj && qs.stringify(obj);
	if (str) url = str + ' ' + url;
	return url;
};

Raja.prototype.keyObj = keyObj;

Raja.prototype.keys = function(url, obj) {
	var names = Object.keys(obj);
	if (!names.length) return [url];
	var vec = [];
	names.forEach(function(name) {
		var val = obj[name];
		if (!Array.isArray(val)) val = [val];
		vec.push(orderedPower(val));
	});
	var cp = Comb.cartesianProduct.apply(Comb, vec).toArray();
	var keys = [];
	var self = this;
	cp.forEach(function(vec) {
		var query = {};
		names.forEach(function(name, index) {
			if (vec[index].length) query[name] = vec[index].sort().join(',')
		});
		keys.push(self.key(url, query));
	});
	return keys;
};

function shallow(src, dst) {
	dst = dst || {};
	Object.keys(src).forEach(function(key) {
		dst[key] = src[key];
	});
	return dst;
}

function keyObj(key) {
	if (!key) return {};
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
	if (a == null || b == null) return a === b;
	var bufa = Buffer.isBuffer(a);
	var bufb = Buffer.isBuffer(b);
	if (!bufa && !bufb) return a === b;
	if (!bufa) a = new Buffer(a);
	if (!bufb) b = new Buffer(b);
	return bufferEqual(a, b);
}

function orderedPower(list) {
	var sets = [], iter, cur;
	for (var i=list.length; i > 0; i--) {
		iter = Comb.combination(list, i);
		while (cur = iter.next()) sets.push(cur);
	}
	sets.push([]);
	return sets;
}

