var orm = require('orm');
var queue = require('queue-async');
var LFU = require('lfu-cache');
var qs = require('querystring');
var type = require('type-is');

module.exports = function(raja, opts, cb) {
	var store = new Store(raja, opts);
	orm.connect(opts.store, function(err, db) {
		if (err) return cb(err);
		store.init(db, cb);
	});
};

function Store(raja, opts) {
	this.raja = raja;
	this.lfu = new LFU(opts.cacheSize || 500, opts.cacheDecay || 60000);
	this.lfu.on('eviction', function(key, obj) {
		this.Resource.one(obj.key, function(err, res) {
			if (err) return raja.error(err);
			if (!res) res = new (this.Resource)();
			// alter obj since it is evicted anyway
			var resources = obj.resources;
			if (resources) delete obj.resources;
			var parents = obj.parents;
			if (parents) delete obj.parents;
			// delete obj.itime ? in general, delete keys not in schema ?
			res.save(obj, function(err) {
				if (err) return raja.error(err);
				var q = queue(2);
				if (resources) q.defer(saveRelations.bind(this), res, resources, true);
				if (parents) q.defer(saveRelations.bind(this), res, parents, false);
				q.awaitAll(function(err) {
					if (err) raja.error(err);
				});
			}.bind(this));
		}.bind(this));
	});
}

Store.prototype.init = function(db, cb) {
	var Resource = this.Resource = db.define('Resource', {
		key: { type: 'text', index: true },
		url: { type: 'text' },
		mtime: { type: 'date', time: true, index: true },
		maxage: { type: 'integer' },
		headers: { type: 'object' }, // a hash
		valid: { type: 'boolean', defaultValue: true },
		data: { type: 'binary' },
		code: { type: 'integer', defaultValue: 200 }
	}, {
		table: "raja_cached_resources",
		cache: false, // we cache better :)
		hooks: {
			beforeSave: beforeSaveResource
		},
	});

	Resource.hasMany("children", Resource, {}, {
		reverse : "parents",
		key: true
	});

	var store = this;

	queue(1)
	.defer(Resource.drop)
	.defer(Resource.sync)
	.awaitAll(function(err) {
		cb(err, store);
	});
};

function beforeSaveResource() {
	if (typeof this.data == "string") {
		this.data = new Buffer(this.data);
	}
	if (this.valid == null && this.data != null) {
		this.valid = true;
	} else if (this.valid != null && this.data == null) {
		this.valid = false;
	}
	if (!this.headers) this.headers = {};
	this.mtime = new Date();
}

Store.prototype.get = function(key, vary, cb) {
	if (!cb && typeof vary == "function") {
		cb = vary;
		vary = null;
	}
	if (vary) {
		key = objToKey(key, vary);
	}
	var lfuObj = this.lfu.get(key);
	if (lfuObj) {
		if (lfuObj.valid) return cb(null, lfuObj);
		else return cb();
	}
	this.Resource.one({key: key}, function(err, obj) {
		if (obj) {
			var lfuObj = this.raja.shallow(obj);
			queue(2)
			.defer(getRelations, obj, lfuObj, true)
			.defer(getRelations, obj, lfuObj, false)
			.awaitAll(function(err) {
				if (err) return cb(err);
				this.lfu.set(key, lfuObj);
				cb(err, lfuObj);
			}.bind(this));
		} else {
			cb(err);
		}
	}.bind(this));
};

Store.prototype.del = function(key, cb) {
	this.lfu.remove(key);
	this.Resource.find({key: key}).remove(cb);
};

Store.prototype.invalidate = function(key, cb) {
	// what happens if it does not find any resource ?
	var lfuObj = this.lfu.get(key);
	if (lfuObj) {
		lfuObj.valid = false;
		return cb();
	}
	this.Resource.find({key: key}, function(err, rows) {
		if (err) return cb(err);
		if (rows.length > 1) return cb(new Error("invalidate expects only one resource at " + key));
		else if (rows.length == 0) return cb();
		rows[0].valid = false;
		rows[0].save(cb);
	});
};

Store.prototype.invalidateParents = function(msg, cb) {
	var raja = this.raja;
	var key = msg.parents.slice(-1).pop() || msg.url;
	var lfu = this.lfu;
	var lfuObj = lfu.get(key);
	var lfuParents = lfuObj && lfuObj.parents;
	var onlyCache = true;
	var sentMsg = {};
	if (lfuParents) for (var pkey in lfuParents) {
		var robj = lfu.get(pkey);
		if (robj) {
			robj.valid = false; // robj is a pointer to the object in lfu, no need to lfu.set
			var cmsg = raja.shallow(msg);
			cmsg.parents = msg.parents.slice();
			cmsg.parents.push(pkey);
			sentMsg[pkey] = true;
			raja.send(cmsg);
		} else {
			onlyCache = false;
		}
	} else {
		onlyCache = false;
		lfuParents = {};
	}

	if (onlyCache) return cb();

	this.Resource.find({key: key}, function(err, rows) {
		if (err) return cb(err);
		if (rows.length > 1) return cb(new Error("invalidateParents expects only one resource at " + key));
		else if (rows.length == 0) return cb();
		var res = rows[0];
		res.getParents().each(function(par) {
			if (sentMsg[par.key]) return; // already dealt with
			var lfuObj = lfu.get(par.key);
			if (lfuObj) lfuObj.valid = false;
			par.valid = false;
			var cmsg = raja.shallow(msg);
			cmsg.parents = msg.parents.slice();
			cmsg.parents.push(par.key);
			raja.send(cmsg);
		}).save(cb);
	});
};

Store.prototype.set = function(key, obj, cb) {
	if (!cb && typeof obj == "function") {
		cb = obj;
		obj = null;
	}
	if (!obj.url) obj.url = key;
	if (key == obj.url) {
		key = obj.key = objToKey(key, headersToVary(obj.headers));
	}
	var lfu = this.lfu;
	var lfuObj = lfu.get(key);
	// remove previous associations if we are going to update them
	if (obj.resources && lfuObj && lfuObj.resources) for (var rkey in lfuObj.resources) {
		var robj = lfu.get(rkey);
		if (robj && robj.parents) delete robj.parents[key];
	}
	lfuObj = this.raja.shallow(obj, lfuObj || {});
	// add new associations if this obj defines them
	if (obj.resources && lfuObj.resources) {
		Object.keys(lfuObj.resources).forEach(function(rkey) {
			var mime = lfuObj.resources[rkey];
			if (typeof mime == "string") {
				var newrkey = objToKey(rkey, headersToVary({'Content-Type': mime, 'Vary': 'Content-Type'}));
				if (newrkey != rkey) {
					delete lfuObj.resources[rkey];
					lfuObj.resources[newrkey] = true;
					rkey = newrkey;
				}
			}
			var robj = lfu.get(rkey);
			if (!robj) {
				robj = {key: rkey};
				beforeSaveResource.call(robj);
				lfu.set(rkey, robj);
			}
			if (!robj.parents) {
				robj.parents = {};
			}
			// do not mess with whatever was put there
			if (!robj.parents[key]) robj.parents[key] = true;
		});
	}
	beforeSaveResource.call(lfuObj);
	this.lfu.set(key, lfuObj);
	// this api should not be async
	cb(null, lfuObj);
};

function saveRelations(inst, hash, isChildren, cb) {
	var self = this;
	this.Resources.find({key: Object.keys(hash)}).run(function(err, rows) {
		if (err) return cb(err);
		var notfound = self.raja.shallow(hash);
		rows.forEach(function(row) {
			delete notfound[row.key];
		});
		var q = queue(3);
		for (var rkey in notfound) {
			q.defer(function(rkey, cb) {
				(new self.Resource({key: rkey})).save(cb);
			}, rkey);
		}
		q.awaitAll(function(err, savedRows) {
			var total = rows.concat(savedRows);
			if (isChildren) inst.setChildren(total, cb);
			else inst.setParents(total, cb);
		});
	});
}

function getRelations(inst, lfuObj, isChildren, cb) {
	var hash, method;
	if (isChildren) {
		hash = lfuObj.resources = {};
		method = obj.getChildren;
	} else {
		hash = lfuObj.parents = {};
		method = obj.getParents;
	}
	method.call(obj, function(err, rows) {
		if (err) return cb(err);
		rows.forEach(function(row) {
			hash[row.key] = true;
		});
		cb();
	});
}

/* might never be needed
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
*/
function headersToVary(headers) {
	var vary = {};
	if (!headers) return vary;
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
}
function objToKey(url, obj) {
	for (var k in obj) if (obj[k] == null) delete obj[k];
	var str = obj && qs.stringify(obj);
	if (str) url = str + ' ' + url;
	return url;
}
Store.prototype.key = objToKey;

