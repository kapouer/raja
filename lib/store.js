var orm = require('orm');
var queue = require('queue-async');
var Cache = require('adaptative-replacement-cache');

module.exports = function(raja, opts, cb) {
	var store = new Store(raja, opts);
	orm.connect(opts.store, function(err, db) {
		if (err) return cb(err);
		store.init(db, cb);
	});
};

function Store(raja, opts) {
	this.raja = raja;
	this.cache = new Cache(opts.cacheSize || 500);
	this.cache.on('eviction', function(key, obj) {
		this.SlowResource.one(obj.key, function(err, res) {
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
	var SlowResource = this.SlowResource = db.define('SlowResource', {
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

	SlowResource.hasMany("children", SlowResource, {}, {
		reverse : "parents",
		key: true
	});

	var store = this;

	queue(1)
	.defer(SlowResource.drop)
	.defer(SlowResource.sync)
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

Store.prototype.get = function(key, cb) {
	var resource = this.cache.get(key);
	if (resource) {
		if (resource.valid) return cb(null, resource);
		else return cb();
	}
	this.SlowResource.one({key: key}, function(err, row) {
		if (err || !row) return cb(err);
		var resource = this.raja.create(row);
		queue(2)
		.defer(getRelations, row, resource, true)
		.defer(getRelations, row, resource, false)
		.awaitAll(function(err) {
			if (err) return cb(err);
			this.cache.set(key, resource);
			cb(err, resource);
		}.bind(this));
	}.bind(this));
};

Store.prototype.del = function(key, cb) {
	this.cache.del(key);
	this.SlowResource.find({key: key}).remove(cb);
};

Store.prototype.invalidate = function(key, cb) {
	// what happens if it does not find any resource ?
	var resource = this.cache.get(key);
	if (resource) {
		resource.valid = false;
		return cb();
	}
	this.SlowResource.find({key: key}, function(err, rows) {
		if (err) return cb(err);
		if (rows.length > 1) return cb(new Error("invalidate expects only one resource at " + key));
		else if (rows.length == 0) return cb();
		rows[0].valid = false;
		rows[0].save(cb);
	});
};

Store.prototype.invalidateParents = function(msg, cb) {
	var raja = this.raja;
	var cache = this.cache;
	var key = msg.parents.slice(-1).pop() || msg.url; // is this a key, really ? same problem as in raja client
	var resource = cache.get(key);
	var parents = resource && resource.parents;
	var onlyCache = true;
	var sentMsg = {};
	if (parents) for (var pkey in parents) {
		var parentResource = cache.get(pkey);
		if (!parentResource) {
			onlyCache = false;
			continue;
		}
		parentResource.valid = false;
		var cmsg = raja.shallow(msg);
		cmsg.parents = msg.parents.slice();
		cmsg.parents.push(pkey);
		sentMsg[pkey] = true;
		raja.send(cmsg);
	} else {
		onlyCache = false;
		parents = {};
	}

	if (onlyCache) return cb();

	this.SlowResource.find({key: key}, function(err, rows) {
		if (err) return cb(err);
		if (rows.length > 1) return cb(new Error("invalidateParents expects only one resource at " + key));
		else if (rows.length == 0) return cb();
		var res = rows[0];
		res.getParents().each(function(par) {
			if (sentMsg[par.key]) return; // already dealt with
			var parentResource = cache.get(par.key);
			if (parentResource) parentResource.valid = false;
			par.valid = false;
			var cmsg = raja.shallow(msg);
			cmsg.parents = msg.parents.slice();
			cmsg.parents.push(par.key);
			raja.send(cmsg);
		}).save(cb);
	});
};

Store.prototype.set = function(key, resource) {
	var raja = this.raja;
	var cache = this.cache;
	var oldResource = cache.get(key);
	// remove previous associations if we are going to update them
	if (oldResource && oldResource.resources && resource.resources) for (var rkey in oldResource.resources) {
		var childResource = cache.get(rkey);
		if (childResource && childResource.parents) delete childResource.parents[key];
	}
	// set new associations
	if (resource.resources) {
		Object.keys(resource.resources).forEach(function(rkey) {
			var childResource = cache.get(rkey);
			if (!childResource) {
				childResource = raja.create({key: rkey});
				beforeSaveResource.call(childResource);
				cache.set(rkey, childResource);
			}
			if (!childResource.parents) {
				childResource.parents = {};
			}
			// do not mess with whatever was put there
			if (!childResource.parents[key]) childResource.parents[key] = true;
		});
	}
	beforeSaveResource.call(resource);
	cache.set(key, resource);
};

function saveRelations(inst, hash, isChildren, cb) {
	var self = this;
	var SlowResource = this.SlowResource;
	SlowResource.find({key: Object.keys(hash)}).run(function(err, rows) {
		if (err) return cb(err);
		var notfound = self.raja.shallow(hash);
		rows.forEach(function(row) {
			delete notfound[row.key];
		});
		var q = queue(3);
		for (var rkey in notfound) {
			q.defer(function(rkey, cb) {
				(new SlowResource({key: rkey})).save(cb);
			}, rkey);
		}
		q.awaitAll(function(err, savedRows) {
			var total = rows.concat(savedRows);
			if (isChildren) inst.setChildren(total, cb);
			else inst.setParents(total, cb);
		});
	});
}

function getRelations(row, resource, isChildren, cb) {
	var hash, method;
	if (isChildren) {
		hash = resource.resources = {};
		method = row.getChildren;
	} else {
		hash = resource.parents = {};
		method = row.getParents;
	}
	method.call(row, function(err, rows) {
		if (err) return cb(err);
		rows.forEach(function(row) {
			hash[row.key] = true;
		});
		cb();
	});
}

