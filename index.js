var	_ = require ('lodash'),
	Promises = require ('vow'),
	EventEmitter = require ('events').EventEmitter;

var DEBUG = false;

var Lock = {
	disposing: null,
	disposeDelayed: null,
	disposeDelay: 5000,

	locks: null,
	locked: null,

	/*
		* Lock object by other object (both should inherit this prototype)
	*/
	lock: function (locker) {
		if (!locker) {
			throw new Error ('You must specify locker object');
		}

		if (this.disposing) {
			throw new Error ('Currently disposing #' + this.id);
		}

		if (locker == this) {
			return;
		}


		if (this.locked == undefined) {
			this.locked = [locker];
		} else {
			if (this.locked.indexOf (locker) === -1) {
				this.locked [this.locked.length] = locker;
			} else {
				// console.warn ('Already locked', this.id, 'by', locker.id);
			}
		}
		
		if (locker.locks == undefined) {
			locker.locks = [this];
		} else {
			if (locker.locks.indexOf (this) === -1) {
				locker.locks [locker.locks.length] = this;
			} else {
				// console.warn ('Locker', locker.id, 'already locks', this.id);
			}
		}

		return this;
	},

	/*
		* Unlock object from other object (both should inherit this prototype)
	*/
	unlock: function (locker) {
		if (!locker) throw new Error ('Who is trying to release me?');
		if (locker == this) return;

		if (this.locked && this.locked.length) {
			var i = this.locked.indexOf (locker);

			if (i === -1) {
				if (!this.disposing && DEBUG) {
					try {
						throw new Error ('trace me');
					} catch (e) {
						console.warn ('I was not locked by', locker, this.id, e.stack);
					}
				}
			} else {
				this.locked.splice (i, 1);
			}

			if (this.locked.length == 0) {
				this.locked = null;
			}
		}

		if (locker.locks && locker.locks.length) {
			i = locker.locks.indexOf (this);

			if (i === -1) {
				if (!this.disposing && DEBUG) {
					try {
						throw new Error ('trace me');
					} catch (e) {
						console.warn ('You were not locking me #' + this.id, e.stack);
					}
					
				}
			} else {
				locker.locks.splice (i, 1);
			}

			if (locker.locks.length == 0) {
				locker.locks = null;
			}
		}
	},

	/*
		* Release object from "locker" lock and dispose, if nobody locks it anymore
	*/
	release: function (by) {
		if (by) {
			this.unlock (by);
		}

		if (this.locked && this.locked.length) {
			return;
		}

		if ((typeof this.isFree == 'function') && !this.isFree ()) {
			return;
		}
		

		if (this.disposing) {
			// if (this.id) {
			// 	console.warn ('Already disposing #' + this.id);
			// } else {
			// 	console.warn ('Already disposing', this);
			// }
			
			return;
		}

		if (this.disposeDelayed) {
			clearTimeout (this.disposeDelayed);
			this.disposeDelayed = null;
		}

		var cleanup = _.bind (function cleanupLocks () {
			if (this.locks) {
				_.each (this.locks, function cleanupLocksRelease (o) {
					if (o) o.release (this);
				}, this);

				this.locks = null;
			}

			return this;
		}, this);

		this.disposeDelayed = setTimeout (_.bind (function afterDisposeDelayed () {
			if (this.locked && this.locked.length) {
				return;
			}

			this.disposeDelayed = null;

			this.emit ('release');
			this.removeAllListeners ();

			if (this.fetching) {
				this.fetching.reject ('fetching broke by dispose');
			}
			this.fetching = null;

			this.disposing = true;

			this.dispose ();
			cleanup ();
		}, this), this.disposeDelay);
	},

	forceRelease: function () {
		if (this.disposing) return;

		_.delay (_.bind (function () {
			if (this.locked && this.locked.length) {
				_.each (this.locked, function forceReleaseLocked (locked) {
					if (locked) {
						this.release (locked);
					}
				}, this);
			}

			this.release ();
		}, this), this.disposeDelay);
	},

	dispose: function () {
		console.error ('no dispose for', this);
		throw 'Dispose behaviour not implemented';
	}
};

var Ready = {
	isReady: false,
	fetching: false,
	error: null,
	refetching: false,

	/*
		* If object is ready, return object. Otherwise, try to call fetch return promise, which
		* should be resolved on "ready" event.
	*/
	ready: function (callback) {
		if (this.isReady) {
			if (typeof callback == 'function') {
				callback.call (this, this);
			}

			return this;
		}

		if (this.fetching) {
			return this.fetching;
		}

		// TODO: deprecated
		// Temporary function to imitate deprecated api
		var self = this;
		var fixReady = function (promise) {
			promise.ready = function promiseIsReady (callback) {
				if (callback) {
					promise.then (_.bind (callback, self));
				}

				return promise;
			};

			return promise;
		};

		if (this.fetch) {
			this.fetching = fixReady (Promises.promise ());

			return fixReady (
				Promises.when (this.fetch ())
					.then (_.bind (this.fetched, this))
					.then (_.bind (this.returnReady, this))
					.fail (_.bind (this.returnError, this))
			);
		}
	},

	/*
		* Switch object to error state
	*/
	returnError: function (error) {
		this.error = error;

		if (this.fetching) {
			// this.fetching.fulfill (this);
			this.fetching.reject (error);
			this.fetching = false;
			this.refetching = false;
		}

		if (this.failed) {
			return this.failed (error);
		}

		this.release ();

		return this;
	},

	/*
		* Switch object to ready state
	*/
	returnReady: function () {
		if (this.disposing) {
			return;
		}

		this.error = null;
		this.isReady = true;

		if (this.fetching) {
			this.fetching.fulfill (this);
			this.fetching = false;
			this.refetching = false;
		}

		return this;
	},

	/*
		* Switch object state back to "unready"
	*/
	returnNotReady: function () {
		this.isReady = false;
		this.fetching = false;
		this.refetching = false;
		return this;
	},

	/*
		* Refetch source
	*/
	refetch: function () {
		if (this.fetching) {
			return this.fetching;
		} else {
			this.fetching = Promises.promise ();
			this.refetching = true;

			return Promises.when (this.fetch ())
				.then (_.bind (this.fetched, this))
				.then (_.bind (this.returnReady, this))
				.fail (_.bind (this.returnError, this));
		}
	},

	fetched: function () {
		throw new Error ('Not implemented');
	}
};


var Emitter = EventEmitter.prototype;

module.exports = function (A) {
	_.extend (A.prototype, Emitter, Lock, Ready);
};