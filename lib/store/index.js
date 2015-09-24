var queue = require('queue-async');
var Cache = require('adaptative-replacement-cache');
var CacheDebounce = require('cache-debounce');
var debug = require('debug')('raja:store');
var Objection = require('objection');
var Resource = require('./resource');
var Relation = require('./relation');

module.exports = function(raja, opts, cb) {
	var store = new Store(raja, opts);
	store.init(opts, cb);
};

function Store(raja, opts) {
	this.raja = raja;
	this.cache = new Cache(opts.cacheSize || 500);
	this.limbo = {};
//	this.cache.on('eviction', function(key, resource) {
//	}.bind(this));
}

Store.prototype.init = function(opts, cb) {
	var initialize = require('./initialize');
	var knex = require('knex')(opts.store);
	Objection.Model.knex(knex);
	var k = knex.schema;
	if (opts.reset) k = initialize.down(knex);
	var self = this;
	k.then(function() {
		initialize.up(knex).asCallback(function(err) {
			cb(err, self);
		});
	});
};

Store.prototype.store = CacheDebounce(function(key, obj, cb) {
	debug('store', key);
	var resources = obj.resources;
	Resource.query().where('key', key).asCallback(function(err, rows) {
		if (err) return cb(err);
		if (rows.length > 1) return cb(new Error("corrupted raja cache - duplicates of " + key));
		var resource = rows.length && rows[0];
		var query;
		if (!resource) {
			obj.key = key;
			query = Resource.query().insert(obj);
			debug('new Resource', key);
		} else {
			resource.$setJson(obj);
			query = Resource.query().update(resource).where('id', resource.id);
		}
		query.asCallback(function(err, resource) {
			if (err) return cb(err);
			saveRelations.call(this, resource, resources, cb);
		}.bind(this));
	}.bind(this));
}, function(key) {
	return key;
});

Store.prototype.get = function(key, cb) {
	debug('get', key);
	var resource = this.cache.get(key) || this.limbo[key];
	if (resource) {
		if (checkAge.call(this, resource, cb)) return;
		return setImmediate(function() {
			cb(null, resource);
		});
	}
	Resource.query().where('key', key).first().eager(['parents', 'children']).asCallback(function(err, resource) {
		if (err || !resource) return cb(err);
		if (checkAge.call(this, resource, cb)) return;
		this.cache.set(key, resource);
		cb(null, resource);
	}.bind(this));
};

function checkAge(resource, cb) {
	if (resource.mtime && resource.maxage > 0) {
		if (Date.parse(resource.mtime) + resource.maxage * 1000 < Date.now()) {
			// perempted resource
			// TODO honour Cache-Control: max-stale here but keep in mind the peremption also hits sessions
			// so Cache-Control must be granular to the resource
			this.del(resource.key, cb);
			return true;
		}
	}
}

Store.prototype.del = function(key, cb) {
	debug('del', key);
	var cache = this.cache;
	var limbo = this.limbo;

	var resource = cache.get(key);
	if (resource) cache.del(key);
	else resource = limbo[key];
	delete limbo[key];

	var rkey;
	if (resource) {
		resource.valid = false;
		if (resource.resources) for (rkey in resource.resources) {
			var childResource = cache.get(rkey) || limbo[rkey];
			if (childResource && childResource.parents) {
				delete childResource.parents[key];
			}
		}
		if (resource.parents) for (rkey in resource.parents) {
			var parentResource = cache.get(rkey) || limbo[rkey];
			if (parentResource && parentResource.resources) {
				delete parentResource.resources[key];
			}
		}
	}
	Resource.query().where('key', key).first().then(function(resource) {
		if (!resource) return cb();
		resource.$relatedQuery('parents').unrelate();
		resource.$relatedQuery('children').unrelate();
		resource.delete().asCallback(cb);
	});
};

Store.prototype.invalidate = function(key, cb) {
	// what happens if it does not find any resource ?
	var resource = this.cache.get(key) || this.limbo[key];
	if (resource) {
		resource.valid = false;
		debug("invalidate cached", key);
		cb();
		cb = this.raja.error;
	}
	Resource.query().patch({valid: false}).where('key', key).asCallback(function(err) {
		debug("invalidate stored", key);
		cb(err, this);
	}.bind(this));
};

Store.prototype.invalidateParents = function(msg, cb) {
	var raja = this.raja;
	var cache = this.cache;
	var limbo = this.limbo;
	var key = msg.parents.slice(-1).pop() || msg.key;
	if (!key) return cb(new Error("Missing key in " + JSON.stringify(msg)));
	var resource = cache.get(key) || limbo[key];
	var parents = resource && resource.parents;
	var sentMsg = {};
	if (parents) for (var pkey in parents) {
		var parentResource = cache.get(pkey) || limbo[pkey];
		if (!parentResource) {
			continue;
		}
		parentResource.valid = false;
		var cmsg = raja.shallow(msg);
		cmsg.parents = msg.parents.slice();
		cmsg.parents.push(pkey);
		sentMsg[pkey] = true;
		raja.send(cmsg);
	} else {
		parents = {};
	}

	// TODO: do all updates in one request, use a transaction

	Resource.query().where('key', key).eager('parents').asCallback(function(err, rows) {
		if (err) return cb(err);
		if (rows.length > 1) return cb(new Error("invalidateParents expects only one resource at " + key));
		else if (rows.length == 0) return cb();
		var topatch = [];
		rows[0].parents.forEach(function(par) {
			var key = par.key;
			if (sentMsg[key]) return; // already dealt with
			var parentResource = cache.get(key) || limbo[key];
			if (parentResource) parentResource.valid = false;
			topatch.push(key);
			var cmsg = raja.shallow(msg);
			cmsg.parents = msg.parents.slice();
			cmsg.parents.push(key);
			raja.send(cmsg);
		});
		Resource.query().patch({valid: false}).whereIn('key', topatch).asCallback(cb);
	});
};

Store.prototype.set = function(key, resource, cb) {
	debug('set', key);
	var raja = this.raja;
	cb = cb || raja.error;
	var cache = this.cache;
	var limbo = this.limbo;
	var oldResource = cache.get(key) || limbo[key];
	// remove previous associations if we are going to update them
	var rkey;
	if (oldResource && oldResource.resources && resource.resources) for (rkey in oldResource.resources) {
		if (resource.resources[rkey]) continue;
		var childResource = cache.get(rkey) || limbo[rkey];
		if (childResource && childResource.parents) {
			debug("delete parent", key, "of child", rkey);
			delete childResource.parents[key];
		}
	}
	if (oldResource && oldResource.parents && resource.parents) for (rkey in oldResource.parents) {
		if (resource.parents[rkey]) continue;
		var parentResource = cache.get(rkey) || limbo[rkey];
		if (parentResource && parentResource.resources) {
			debug("delete child", key, "of parent", rkey);
			delete parentResource.resources[key];
		}
	}
	// set new associations
	if (resource.resources) {
		Object.keys(resource.resources).forEach(function(rkey) {
			var child = cache.get(rkey) || limbo[rkey];
			if (!child) {
				debug('create child', rkey);
				child = raja.create({key: rkey}, resource.resources[rkey]);
			}
			if (!child.parents) {
				child.parents = {};
			}
			// do not mess with whatever was put there
			if (!child.parents[key]) {
				child.parents[key] = true;
			}
		});
	}
	if (resource.parents) {
		Object.keys(resource.parents).forEach(function(rkey) {
			var parent = cache.get(rkey) || limbo[rkey];
			if (!parent) {
				debug('create parent', rkey);
				parent = raja.create({key: rkey}, resource.parents[rkey]);
			}
			if (!parent.resources) {
				parent.resources = {};
			}
			// do not mess with whatever was put there
			if (!parent.resources[key]) {
				parent.resources[key] = true;
			}
		});
	}
	Resource.prototype.beforeSave.call(resource);
	cache.set(key, resource);
	limbo[key] = resource;
	this.store(key, resource, function(err) {
		delete limbo[key];
		debug('wrote', key);
		cb(err, resource);
	});
};

Store.prototype.expire = function(builder, cb) {
	Resource.query().where('builder', builder)
	.andWhere('maxage', '>', 0)
	.andWhere('mtime', '<', Resource.raw("now() - (maxage || ' seconds')::interval"))
	.del().asCallback(cb);
};

function saveRelations(inst, hash, cb) {
	if (!hash) return cb(null, inst);
	var self = this;
	var keys = Object.keys(hash);
	var orders = {};
	keys.forEach(function(key, index) {
		orders[key] = index;
	});
	var q = queue();
	keys.forEach(function(key) {
		var obj = hash[key];
		if (obj === true) obj = {};
		q.defer(self.store.bind(self), key, obj);
	});
	q.awaitAll(function(err, resources) {
		if (err) return cb(err);
		var relations = resources.map(function(row, order) {
			return {
				parent_id: inst.id,
				child_id: row.id,
				order: order
			};
		});
		inst.$relatedQuery('children').unrelate().asCallback(function(err) {
			if (err) return cb(err);
			Relation.knexQuery().insert(relations).asCallback(function(err) {
				cb(err, inst);
			});
		});
	});
}

