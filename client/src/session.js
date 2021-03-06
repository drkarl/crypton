/* Crypton Client, Copyright 2013 SpiderOak, Inc.
 *
 * This file is part of Crypton Client.
 *
 * Crypton Client is free software: you can redistribute it and/or modify it
 * under the terms of the Affero GNU General Public License as published by the
 * Free Software Foundation, either version 3 of the License, or (at your
 * option) any later version.
 *
 * Crypton Client is distributed in the hope that it will be useful, but
 * WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY
 * or FITNESS FOR A PARTICULAR PURPOSE.  See the Affero GNU General Public
 * License for more details.
 *
 * You should have received a copy of the Affero GNU General Public License
 * along with Crypton Client.  If not, see <http://www.gnu.org/licenses/>.
*/

(function () {

'use strict';

var ERRS;

/**!
 * # Session(id)
 *
 * ````
 * var session = new crypton.Session(id);
 * ````
 *
 * @param {Number} id
 */
var Session = crypton.Session = function (id) {
  ERRS = crypton.errors;
  this.id = id;
  this.peers = {};
  this.events = {};
  this.containers = [];
  this.items = {};
  this.inbox = new crypton.Inbox(this);

  var that = this;
  this.socket = io.connect(crypton.url(), {
    secure: true
  });

  // watch for incoming Inbox messages
  this.socket.on('message', function (data) {
    that.inbox.get(data.messageId, function (err, message) {
      that.emit('message', message);
    });
  });

  // watch for container update notifications
  this.socket.on('containerUpdate', function (containerNameHmac) {
    // if any of the cached containers match the HMAC
    // in the notification, sync the container and
    // call the listener if one has been set
    for (var i = 0; i < that.containers.length; i++) {
      var container = that.containers[i];
      var temporaryHmac = container.containerNameHmac || container.getPublicName();

      if (crypton.constEqual(temporaryHmac, containerNameHmac)) {
        container.sync(function (err) {
          if (container._listener) {
            container._listener();
          }
        });

        break;
      }
    }
  });

  // watch for Item update notifications
  this.socket.on('itemUpdate', function (itemObj) {
    if (!itemObj.itemNameHmac || !itemObj.creator || !itemObj.toUsername) {
      console.error(ERRS.ARG_MISSING);
      throw new Error(ERRS.ARG_MISSING);
    }
    console.log('Item updated!', itemObj);
    // if any of the cached items match the HMAC
    // in the notification, sync the items and
    // call the listener if one has been set
    if (that.items[itemObj.itemNameHmac]) {

      that.items[itemObj.itemNameHmac].sync(function (err) {
        if (err) {
          return console.error(err);
        }

        try {
          that.events.onSharedItemSync(that.items[itemObj.itemNameHmac]);
        } catch (ex) {
          console.warn(ex);
        }

        if (that.items[itemObj.itemNameHmac]._listener) {
          that.items[itemObj.itemNameHmac]._listener(err);
        }
      });
    } else {
      console.log('Loading the item as it is not cached');
      // load item!
      // get the peer first:
      that.getPeer(itemObj.creator, function (err, peer) {
        if (err) {
          console.error(err);
          console.error('Cannot load item: creator peer cannot be found');
          return;
        }
        // XXXddahl: Make sure you trust this peer before loading the item
        //           Perhaps we check this inside the Item constructor?
        var itemCallback = function _itemCallback (err, item) {
          if (err) {
            console.error(err);
            return;
          }
          that.items[itemObj.itemNameHmac] = item;
          try {
            that.events.onSharedItemSync(item);
          } catch (ex) {
            console.warn(ex);
          }
        };

        var item =
          new crypton.Item(null, null, that, peer,
                           itemCallback, itemObj.itemNameHmac);

      });
    }
  });
};

/**!
 * ### removeItem(itemNameHmac, callback)
 * Remove/delete Item with given 'itemNameHmac',
 * both from local cache & server
 *
 * Calls back with success boolean and without error if successful
 *
 * Calls back with error if unsuccessful
 *
 * @param {String} itemNameHmac
 * @param {Function} callback
 */
Session.prototype.removeItem = function removeItem (itemNameHmac, callback) {
  var that = this;
  for (var name in this.items) {
    if (this.items[name].nameHmac == itemNameHmac) {
      this.items[name].remove(function (err) {
        if (err) {
          console.error(err);
          callback(err);
          return;
        }
        if (that.items[name].deleted) {
          delete that.items[name];
          callback(null);
        }
      });
    }
  }
};

/**!
 * ### getOrCreateItem(itemName, callback)
 * Create or Retrieve Item with given platintext `itemName`,
 * either from local cache or server
 *
 * This method is for use by the creator of the item.
 * Use 'session.getSharedItem' for items shared by the creator
 *
 * Calls back with Item and without error if successful
 *
 * Calls back with error if unsuccessful
 *
 * @param {String} itemName
 * @param {Function} callback
 */
Session.prototype.getOrCreateItem =
function getOrCreateItem (itemName,  callback) {

  if (!itemName) {
    return callback('itemName is required');
  }
  if (!callback) {
    throw new Error('Missing required callback argument');
  }
  // Get cached item if exists
  // XXXddahl: check server for more recent item?
  // We need another server API like /itemupdated/<itemHmacName> which returns
  // the timestamp of the last update
  if (this.items[itemName]) {
    callback(null, this.items[itemName]);
    return;
  }

  var creator = this.createSelfPeer();
  var item =
  new crypton.Item(itemName, null, this, creator, function getItemCallback(err, item) {
    if (err) {
      console.error(err);
      return callback(err);
    }
    callback(null, item);
  });
};

/**!
 * ### getSharedItem(itemNameHmac, peer, callback)
 * Retrieve shared Item with given itemNameHmac,
 * either from local cache or server
 *
 * Calls back with Item and without error if successful
 *
 * Calls back with error if unsuccessful
 *
 * @param {String} itemNameHmac
 * @param {Object} peer
 * @param {Function} callback
 */
Session.prototype.getSharedItem =
function getSharedItem (itemNameHmac,  peer, callback) {
  // TODO:  Does not check for cached item or server having a fresher Item
  if (!itemNameHmac) {
    return callback(ERRS.ARG_MISSING);
  }
  if (!callback) {
    throw new Error(ERRS.ARG_MISSING_CALLBACK);
  }

  function getItemCallback(err, item) {
    if (err) {
      console.error(err);
      return callback(err);
    }
    callback(null, item);
  }

  new crypton.Item(null, null, this, peer, getItemCallback, itemNameHmac);
};

/**!
 * ### createSelfPeer()
 * returns a 'selfPeer' object which is needed for any kind of
 * self-signing, encryption or verification
 *
 */
Session.prototype.createSelfPeer = function () {
  var selfPeer = new crypton.Peer({
    session: this,
    pubKey: this.account.pubKey,
    signKeyPub: this.account.signKeyPub,
    signKeyPrivate: this.account.signKeyPrivate,
    username: this.account.username
  });
  selfPeer.trusted = true;
  return selfPeer;
};

/**!
 * ### load(containerName, callback)
 * Retieve container with given platintext `containerName`,
 * either from local cache or server
 *
 * Calls back with container and without error if successful
 *
 * Calls back with error if unsuccessful
 *
 * @param {String} containerName
 * @param {Function} callback
 */
Session.prototype.load = function (containerName, callback) {
  // check for a locally stored container
  for (var i = 0; i < this.containers.length; i++) {
    if (crypton.constEqual(this.containers[i].name, containerName)) {
      callback(null, this.containers[i]);
      return;
    }
  }

  // check for a container on the server
  var that = this;
  this.getContainer(containerName, function (err, container) {
    if (err) {
      callback(err);
      return;
    }

    that.containers.push(container);
    callback(null, container);
  });
};

/**!
 * ### loadWithHmac(containerNameHmac, callback)
 * Retieve container with given `containerNameHmac`,
 * either from local cache or server
 *
 * Calls back with container and without error if successful
 *
 * Calls back with error if unsuccessful
 *
 * @param {String} containerNameHmac
 * @param {Function} callback
 */
Session.prototype.loadWithHmac = function (containerNameHmac, peer, callback) {
  // check for a locally stored container
  for (var i = 0; i < this.containers.length; i++) {
    if (crypton.constEqual(this.containers[i].nameHmac, containerNameHmac)) {
      callback(null, this.containers[i]);
      return;
    }
  }

  // check for a container on the server
  var that = this;
  this.getContainerWithHmac(containerNameHmac, peer, function (err, container) {
    if (err) {
      callback(err);
      return;
    }

    that.containers.push(container);
    callback(null, container);
  });
};

/**!
 * ### create(containerName, callback)
 * Create container with given platintext `containerName`,
 * save it to server
 *
 * Calls back with container and without error if successful
 *
 * Calls back with error if unsuccessful
 *
 * @param {String} containerName
 * @param {Function} callback
 */
Session.prototype.create = function (containerName, callback) {
  for (var i in this.containers) {
    if (crypton.constEqual(this.containers[i].name, containerName)) {
      callback('Container already exists');
      return;
    }
  }

  var selfPeer = new crypton.Peer({
    session: this,
    pubKey: this.account.pubKey,
    signKeyPub: this.account.signKeyPub
  });
  selfPeer.trusted = true;

  var sessionKey = crypton.randomBytes(32);
  var sessionKeyCiphertext = selfPeer.encryptAndSign(sessionKey);

  if (sessionKeyCiphertext.error) {
    return callback(sessionKeyCiphertext.error);
  }

  delete sessionKeyCiphertext.error;

  // TODO is signing the sessionKey even necessary if we're
  // signing the sessionKeyShare? what could the container
  // creator attack by wrapping a different sessionKey?
  var signature = 'hello';
  var containerNameHmac = new sjcl.misc.hmac(this.account.containerNameHmacKey);
  containerNameHmac = sjcl.codec.hex.fromBits(containerNameHmac.encrypt(containerName));

  // TODO why is a session object generating container payloads? creating the
  // initial container state should be done in container.js
  var rawPayloadCiphertext = sjcl.encrypt(sessionKey, JSON.stringify({
    recordIndex: 0,
    delta: {}
  }), crypton.cipherOptions);

  var payloadCiphertextHash = sjcl.hash.sha256.hash(JSON.stringify(rawPayloadCiphertext));
  var payloadSignature = this.account.signKeyPrivate.sign(payloadCiphertextHash, crypton.paranoia);

  var payloadCiphertext = {
    ciphertext: rawPayloadCiphertext,
    signature: payloadSignature
  };

  var that = this;
  new crypton.Transaction(this, function (err, tx) {
    var chunks = [
      {
        type: 'addContainer',
        containerNameHmac: containerNameHmac
      }, {
        type: 'addContainerSessionKey',
        containerNameHmac: containerNameHmac,
        signature: signature
      }, {
        type: 'addContainerSessionKeyShare',
        toAccount: that.account.username,
        containerNameHmac: containerNameHmac,
        sessionKeyCiphertext: sessionKeyCiphertext,
      }, {
        type: 'addContainerRecord',
        containerNameHmac: containerNameHmac,
        payloadCiphertext: payloadCiphertext
      }
    ];

    async.eachSeries(chunks, function (chunk, callback2) {
      tx.save(chunk, callback2);
    }, function (err) {
      if (err) {
        return tx.abort(function () {
          callback(err);
        });
      }

      tx.commit(function () {
        var container = new crypton.Container(that);
        container.name = containerName;
        container.sessionKey = sessionKey;
        that.containers.push(container);
        callback(null, container);
      });
    });
  });
};

/**!
 * ### deleteContainer(containerName, callback)
 * Request the server to delete all records and keys
 * belonging to `containerName`
 *
 * Calls back without error if successful
 *
 * Calls back with error if unsuccessful
 *
 * @param {String} containerName
 * @param {Function} callback
 */
Session.prototype.deleteContainer = function (containerName, callback) {
  var that = this;
  var containerNameHmac = new sjcl.misc.hmac(this.account.containerNameHmacKey);
  containerNameHmac = sjcl.codec.hex.fromBits(containerNameHmac.encrypt(containerName));

  new crypton.Transaction(this, function (err, tx) {
    var chunk = {
      type: 'deleteContainer',
      containerNameHmac: containerNameHmac
    };

    tx.save(chunk, function (err) {
      if (err) {
        return callback(err);
      }

      tx.commit(function (err) {
        if (err) {
          return callback(err);
        }

        // remove from cache
        for (var i = 0; i < that.containers.length; i++) {
          if (crypton.constEqual(that.containers[i].name, containerName)) {
            that.containers.splice(i, 1);
            break;
          }
        }

        callback(null);
      });
    });
  });
};


/**!
 * ### getContainer(containerName, callback)
 * Retrieve container with given platintext `containerName`
 * specifically from the server
 *
 * Calls back with container and without error if successful
 *
 * Calls back with error if unsuccessful
 *
 * @param {String} containerName
 * @param {Function} callback
 */
Session.prototype.getContainer = function (containerName, callback) {
  var container = new crypton.Container(this);
  container.name = containerName;
  container.sync(function (err) {
    callback(err, container);
  });
};

/**!
 * ### getContainerWithHmac(containerNameHmac, callback)
 * Retrieve container with given `containerNameHmac`
 * specifically from the server
 *
 * Calls back with container and without error if successful
 *
 * Calls back with error if unsuccessful
 *
 * @param {String} containerNameHmac
 * @param {Function} callback
 */
Session.prototype.getContainerWithHmac = function (containerNameHmac, peer, callback) {
  var container = new crypton.Container(this);
  container.nameHmac = containerNameHmac;
  container.peer = peer;
  container.sync(function (err) {
    callback(err, container);
  });
};

/**!
 * ### getPeer(containerName, callback)
 * Retrieve a peer object from the database for given `username`
 *
 * Calls back with peer and without error if successful
 *
 * Calls back with error if unsuccessful
 *
 * @param {String} username
 * @param {Function} callback
 */
Session.prototype.getPeer = function (username, callback) {
  if (this.peers[username]) {
    return callback(null, this.peers[username]);
  }

  var that = this;
  var peer = new crypton.Peer();
  peer.username = username;
  peer.session = this;

  peer.fetch(function (err, peer) {
    if (err) {
      return callback(err);
    }

    that.load(crypton.trustStateContainer, function (err, container) {
      if (err) {
        return callback(err);
      }

      // if the peer has previously been trusted,
      // we should check the saved fingerprint against
      // what the server has given us
      if (!container.keys[username]) {
        peer.trusted = false;
      } else {
        var savedFingerprint = container.keys[username].fingerprint;

        if (!crypton.constEqual(savedFingerprint, peer.fingerprint)) {
          return callback('Server has provided malformed peer', peer);
        }

        peer.trusted = true;
      }

      that.peers[username] = peer;
      callback(null, peer);
    });
  });
};

/**!
 * ### on(eventName, listener)
 * Set `listener` to be called anytime `eventName` is emitted
 *
 * @param {String} eventName
 * @param {Function} listener
 */
// TODO allow multiple listeners
Session.prototype.on = function (eventName, listener) {
  this.events[eventName] = listener;
};

/**!
 * ### emit(eventName, data)
 * Call listener for `eventName`, passing it `data` as an argument
 *
 * @param {String} eventName
 * @param {Object} data
 */
// TODO allow multiple listeners
Session.prototype.emit = function (eventName, data) {
  this.events[eventName] && this.events[eventName](data);
};

})();
