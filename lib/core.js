var queue = require('queue-async');
var events = require('events');
var util = require('util');
var URL = require('url');
var qs = require('querystring');
var typeis = require('type-is').is;
var bufferEqual = require('buffer-equal');
var agent = require('./utils/agent');
var debug = require('debug')('raja:core');

module.exports = function(opts, cb) {
	var raja = new Raja(opts);
	raja.error = Raja.prototype.error.bind(raja);
	raja.agent = agent;

	raja.proxies = {};
	raja.builders = {};

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
	this.unsaved = {};
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
	debug('receive', msg);
	if (!msg.key) return;
	if (!msg.parents) msg.parents = [];
	if (msg.mtime) msg.mtime = new Date(msg.mtime);
	this.emit('message', msg);
	this.store.invalidateParents(msg, function(err) {
		if (err) console.error(err);
	});
};

Raja.prototype.send = function(msg) {
	if (!msg.key) {
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

Raja.prototype.create = function(obj, from) {
	if (typeof obj == "string") obj = {url: obj};
	if (from) {
		obj.headers = this.headers(from);
		if (from.builder) obj.builder = from.builder;
	}
	if (!obj.url) {
		if (from && from.url) {
			obj.url = from.url;
		} else if (obj.key) {
			obj.url = keyObj(obj.key).url;
		} else {
			throw new Error("Missing key in " + JSON.stringify(obj));
		}
	}
	obj.key = this.reskey(obj);
	var inst = this.unsaved[obj.key];
	if (!inst) {
		inst = Object.create(Resource.prototype, {});
		this.shallow(obj, inst);
		debug('create unsaved', inst.key);
		Object.defineProperty(inst, 'raja', {
			enumerable: false,
			value: this
		});
		this.unsaved[inst.key] = inst;
	} else {
		debug('update unsaved', obj.key);
		this.shallow(obj, inst);
	}
	return inst;
};

Raja.prototype.reskey = function(obj, havingHeaders) {
	if (typeof obj == "string") obj = {
		url: obj
	};
	if (!obj.headers && havingHeaders) obj.headers = this.headers(havingHeaders);
	var xRaja = obj.headers && obj.headers['X-Raja'];
	var url = obj.url;
	if (xRaja == this.opts.namespace) {
		url = URL.parse(url).path;
	}
	return this.key(url, this.vary(obj.headers));
};

Raja.prototype.reqkey = function(obj, havingHeaders) {
	if (typeof obj == "string") obj = {
		url: obj
	};
	if (!obj.headers && havingHeaders) obj.headers = this.headers(havingHeaders);
	var xRaja = obj.headers && obj.headers['X-Raja'];
	var url = obj.url;
	if (xRaja == this.opts.namespace) {
		url = URL.parse(url).path;
	}
	return this.key(url, this.variant(obj.headers));
};

Raja.prototype.retrieve = function(url, havingHeaders, cb) {
	if (!cb && typeof havingHeaders == "function") {
		cb = havingHeaders;
		havingHeaders = null;
	}
	var key = this.reskey(url, havingHeaders);
	this.store.get(key, cb);
};

Raja.prototype.upsert = function(obj, cb) {
	debug('upsert', obj);
	this.retrieve(obj.url, obj, function(err, resource) {
		if (err) return cb(err);
		if (!resource) {
			debug('upsert not found, creating');
			resource = this.create(obj);
		} else {
			debug('upsert found, updating', resource.key, resource.headers);
			raja.shallow(obj, resource);
			resource.headers = this.headers(resource);
		}
		cb(null, resource);
	}.bind(this));
};

function Resource() { /* initialization code will not be called by Object.create */ }

Resource.prototype.depend = function(resource, havingHeaders) {
	if (!this.resources) this.resources = {};
	if (!(resource instanceof Resource)) resource = this.raja.create(resource, havingHeaders);
	if (this.key == resource.key) console.warn('A resource cannot depend on itself', this.key);
	else this.resources[resource.key] = resource;
	debug('depend', this.key, resource.key);
};

Resource.prototype.undepend = function(resource) {
	if (!this.resources || !resource) return;
	var key;
	if (typeof resource == "string") key = resource;
	else key = this.raja.reskey(resource);
	delete this.resources[key];
};

Resource.prototype.belong = function(resource, havingHeaders) {
	if (!this.parents) this.parents = {};
	if (!(resource instanceof Resource)) resource = this.raja.create(resource, havingHeaders);
	if (this.key == resource.key) console.warn('A resource cannot belong to itself', this.key);
	else this.parents[resource.key] = resource;
	debug('belong', this.key, resource.key);
};

Resource.prototype.unbelong = function(resource) {
	if (!this.parents || !resource) return;
	var key;
	if (typeof resource == "string") key = resource;
	else key = this.raja.reskey(resource);
	delete this.parents[key];
};

Resource.prototype.save = function(cb) {
	var raja = this.raja;
	cb = cb || raja.error;
	if (!this.url) {
		if (this.key) {
			this.url = keyObj(this.key).url;
		} else {
			throw new Error("Missing key in " + JSON.stringify(this));
		}
	}
	var key = raja.reskey(this);
	if (this.key == key) {
		raja.store.set(key, this, function(err, resource) {
			delete raja.unsaved[key];
			cb(err, resource);
		});
	} else {
		var oldkey = this.key;
		this.key = key;
		var copy = raja.create(this);
		this.key = oldkey;
		if (this.page) delete this.page;
		this.remove(raja.error);
		if (copy.page && copy.page.unlock) copy.page.unlock = function(copy) {
			debug("call page copy unlock");
			delete copy.page;
		}.bind(this, copy);
		copy.save(cb);
	}
};

Resource.prototype.load = function(remote, opts, cb) {
	if (!this.resources) this.resources = {};
	if (!cb && typeof opts == "function") {
		cb = opts;
		opts = null;
	}
	if (!opts) opts = {};
	remote = agent.resolve(this.url, remote);
	var localns = this.headers && this.headers['X-Raja'];
	var remotens = opts.headers && opts.headers['X-Raja'];
	if (localns && !remotens && URL.parse(this.url).host == URL.parse(remote).host) {
		if (!opts.headers) opts.headers = {};
		opts.headers['X-Raja'] = localns;
	}
	this.raja.proxies.remote.get(remote, opts, function(err, resource) {
		if (err >= 400 && err < 500) {
			this.undepend(resource);
		} else if (!err) {
			this.depend(resource);
		}
		cb(err, resource);
	}.bind(this));
};


Resource.prototype.invalidate = function(cb) {
	this.raja.store.invalidate(this.key, cb);
};

Resource.prototype.is = function(mimetype) {
	return typeis(this.headers && this.headers['Content-Type'], mimetype);
};

Resource.prototype.remove = function(cb) {
	// remove from unsave, from limbo, from store, and orphan everywhere
	delete this.raja.unsaved[this.key];
	this.raja.store.del(this.key, cb);
};

Raja.prototype.headers = function(havingHeaders) {
	if (!havingHeaders) return {};
	var obj = {};
	var headers = havingHeaders.headers;
	var hasGet = !!havingHeaders.get;
	if (!headers && !hasGet) headers = havingHeaders;
	['Content-Type', 'Vary', 'ETag', 'Accept', 'X-Grant', 'X-Right', 'X-Author', 'X-Raja'].forEach(function(name) {
		var val = hasGet && havingHeaders.get(name) || headers && (headers[name] || headers[name.toLowerCase()]);
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
		var val = headers[header] || "";
		if (header == 'Content-Type') {
			var type = typeis(val, ['html', 'json', 'xml']);
			if (type && type != 'html') vary.type = type; // store html as default
		} else if (header == 'X-Grant') {
			vary.right = normalizeList(val);
		} else if (header == 'X-Author') {
			vary.author = val;
		}
	});
	return vary;
};

Raja.prototype.variant = function(headers) {
	if (!headers) return;
	var variant = {};
	var accept = headers['Accept'] || "";
	if (accept) {
		// html is considered the default type
		var type = typeis(accept, ['html', 'json', 'xml']);
		if (type && type != 'html') variant.type = type;
	}
	var right = headers['X-Right'] || "";
	if (right) {
		variant.right = normalizeList(right);
	}
	var author = headers['X-Author'];
	if (author) {
		variant.author = author;
	}
	return variant;
};

Raja.prototype.key = function(url, obj) {
	if (!obj) return url;
	for (var k in obj) if (obj[k] == null) delete obj[k];
	var str = obj && qs.stringify(obj);
	if (str) url = str + ' ' + url;
	return url;
};

Raja.prototype.keyObj = keyObj;

function shallow(src, dst) {
	dst = dst || {};
	if (!src) return dst;
	Object.keys(src).forEach(function(key) {
		if (src.hasOwnProperty(key) == false) return;
		var val = src[key];
		if (val === undefined) return;
		if (key == "resources" || key == "parents" || key == "headers") {
			val = shallow(val, dst[key] || {});
		}
		if ((key == 'resources' || key == 'parents') && val && Object.keys(val).length == 0 && dst[key] && Object.keys(dst[key]).length > 0) {
			console.info("not overwriting", key, dst[key], "with empty object");
			return;
		}
		dst[key] = val;
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

function normalizeList(strlist) {
	return strlist.split(',').map(function(str) {return str.trim();}).sort().join(',');
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

