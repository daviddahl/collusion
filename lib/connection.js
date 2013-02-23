// Connection object
//
// Convert an HTTP request (channel) to a loggable, visualizable connection object, if possible

var {
    Cc, Ci, Cr
} = require('chrome');

var eTLDSvc = Cc["@mozilla.org/network/effective-tld-service;1"].
                getService(Ci.nsIEffectiveTLDService);

const { getTabForChannel } = require('./tab/utils');
const {on, once, off, emit} = require('sdk/event/core');



exports.Connection = Connection;


function Connection(){
}


// FIXME: Move persistence into a component
// START PERSISTENCE

var { indexedDB, IDBKeyRange } = require('indexed-db');

function filterSince(timestamp){
    return {
        name: 'since',
        index: 'timestamp',
        lowerBound: timestamp,
        range: IDBKeyRange.lowerBound(timestamp.valueOf()),
        match: function(connection){
            return this.lowerBound <= connection.timestamp;
        }
    };
}

var filter24hours = filterSince(new Date(Date.now() - (24 * 60 * 60 * 1000)));


function filterSource(source){
    return {
        name: 'source',
        index: 'source',
        only: source,
        range: IDBKeyRange.only(source),
        match: function(connection){
            return this.source === connection.source;
        }
    };
};

function filterTarget(target){
    return {
        name: 'target',
        index: 'target',
        only: target,
        range: IDBKeyRange.only(target),
        match: function(connection){
            this.target === connection.target;
        }
    }
};

var connectionFilter = filter24hours; // default filter


var request = indexedDB.open('connectionsdb', 9);
var connectionsdb;

request.onerror = function(event) {
    console.log("failure");
};

request.onsuccess = function(event){
    console.log("success");
    connectionsdb = this.result; // this ==== event.target === request
    connectionsdb.onerror = function(event){
        console.error('Database error: ' + event.target.errorCode);
    };
    console.log('database opened');
    Connection.on('restore', filteredConnections);

    // filteredConnections(restoreComplete);
};


request.onupgradeneeded = function(event){
    var db = event.target.result;
    console.log('upgrading database');
    // Create an objectStore to hold connections
   // db.deleteObjectStore('connections');
    var objectStore = db.createObjectStore('connections', {keyPath: 'id', autoIncrement: true});
    objectStore.createIndex('source', 'source', {unique: false});
    objectStore.createIndex('target', 'target', {unique: false});
    objectStore.createIndex('timestamp', 'timestamp', {unique: false});
    // update existing data, if any
    if (storage.connections){
        JSON.parse(storage.connections).forEach(function(connection){
            connection.__proto__ = Connection.prototype;
            connection.valid = true;
            connection.timestamp = new Date(connection.timestamp);
            objectStore.add(connection);
        });
    }else{
        console.log('no intermediate connections found');
    }
    // delete storage.connections;
};

Connection.setConnectionFilter = function(filter){
}

Connection.getConnectionFilter = function(){
    return connectionFilter;
}

var storage = require("simple-storage").storage;


function filteredConnections(callback){
    if (connectionsdb){
        connectionsdb
            .transaction('connections')
            .objectStore('connections')
            .index(connectionFilter.index)
            .openCursor(connectionFilter.range).onsuccess = function(event){
                var cursor = event.target.result;
                if (cursor) {
                    try{
                        Connection.emit('connection', cursor.value);
                        cursor.continue();
                    }catch(e){
                        console.error('caught this bad boy: ', e);
                        if (callback){
                            callback();
                        }
                    }
                }else{
                    if (callback){
                        callback();
                    }
                }
            };
    }
}

function restore(){
    // only called when add-on is initialized, not when ui page is refreshed
    console.log('calling restore');
    if (!storage.collusionToken){
        storage.collusionToken = require('sdk/util/uuid').uuid().toString();
    }
}

var collusionToken = storage.collusionToken;

Connection.addConnection = function(connection){
    if (!connectionsdb){
        console.error('Database error: Connections database not available yet');
        return;
    }
    var transaction = connectionsdb.transaction(['connections'], 'readwrite');
    transaction.oncomplete = function(event){console.log('Connection added successfully to database');};
    transaction.onerror = function(event){console.log('Connection was not added to database');};
    var objectStore = transaction.objectStore('connections');
    var request = objectStore.add(connection);
    request.onsuccess = function(event){
        if (connectionFilter.match(connection)){
            Connection.emit('connection', connection);
        }
    };
}

function saveConnections(){
    // storage.connections = JSON.stringify(allConnections);
}

Connection.clearAllConnections = function(){
    connectionsdb
        .transaction('connections')
        .objectStore('connections')
        .clear()
        .onsuccess = function(event){
            console.log('all connection data deleted');
        };
};

function getDomain(host) {
  try {
    return eTLDSvc.getBaseDomainFromHost(host);
  } catch (e if e.result === Cr.NS_ERROR_INSUFFICIENT_DOMAIN_LEVELS) {
    return host;
  } catch (e if e.result === Cr.NS_ERROR_HOST_IS_IP_ADDRESS) {
    return host;
  }
}

function isThirdParty(source, target) {
	return getDomain(source) !== getDomain(target);
}


Connection.fromSubject = function(subject){
    var connection = new Connection();
    connection.initFromSubject(subject);
    return connection;
}

Connection.prototype.initFromSubject = function(subject) {
    // Check to see if this is in fact a third-party connection, if not, return
	var channel = subject.QueryInterface(Ci.nsIHttpChannel);
	this.valid = true;
    if (!channel.referrer){
		this.valid = false;
		this.message = 'Connection has no referrer';
		return;
	}
    this.source = channel.referrer.host;
    this.target = channel.URI.host;
	if (!isThirdParty(this.source, this.target)){
		this.valid = false;
		this.message = 'Connection is not a third-party';
		return;
	}
    this.timestamp = new Date();
    this.contentType = channel.contentType || 'text/plain';
    try {
        this.cookie = !! channel.getRequestHeader('Cookie');
    } catch (e) {
        this.cookie = false;
    }
    var protocol = channel.URI.scheme;
    switch (protocol) {
        case 'http':
            this.secure = false;
            break;
        case 'https':
            this.secure = true;
            break;
        default:
            this.valid = false;
            this.message = 'Unsupported protocol: ' + protocol;
            return;
    }
    this.sourcePathDepth = channel.URI.path.split('/').length - 1;
    if (channel.URI.query) {
        this.sourceQueryDepth = channel.URI.query.split(/;|\&/).length;
    } else {
        this.sourceQueryDepth = 0;
    }
    // this._sourceTab = getTabForChannel(channel); // Never logged, only for associating data with current tab
    // this.sourceVisited = (this._sourceTab.linkedBrowser.currentURI.spec === channel.referrer.spec);
    var sourceTab = getTabForChannel(channel); // Never logged, only for associating data with current tab
    this.sourceVisited = (sourceTab.linkedBrowser.currentURI.spec === channel.referrer.spec);
}

// Connection - level methods (not on instances)

Connection.on = function(eventname, handler){
    on(Connection, eventname, handler);
};

Connection.once = function(eventname, handler){
    once(Connection, eventname, handler);
};

Connection.off = function(eventname){
    off(Connection, eventname);
};

Connection.emit = function(eventname, arg1, arg2, arg3){
    emit(Connection, eventname, arg1, arg2, arg3);
};

function log(message){
    Connection.emit('log', message);
}


Connection.prototype.toJSON = function(){
    console.log('Connection.toJSON() called');
    return {
        source: this.source,
        target: this.target,
        timestamp: this.timestamp,
        contentType: this.contentType,
        cookie: this.cookie,
        sourceVisited: this.sourceVisited,
        secure: this.secure,
        sourcePathDepth: this.sourcePathDepth,
        sourceQueryDepth: this.sourceQueryDepth
    };
};


Connection.prototype.toString = function(){
	if (!this.valid){
		return 'Invalid Connection: ' + this.message;
	}
	return '[source: ' + this.source +
	       ', target: ' + this.target +
		   ', timestamp: ' + this.timestamp +
		   ', contentType: ' + this.contentType +
		   ', cookie: ' + this.cookie +
		   ', sourceVisited: ' + this.sourceVisited +
		   ', secure: ' + this.secure +
		   ', sourcePathDepth: ' + this.sourcePathDepth +
		   ', sourceQueryDepth: ' + this.sourceQueryDepth +
		   ', sourceTab: ' + this._sourceTab +
	']';
};


Connection.exportFormat = function(){
    return JSON.stringify({
        format: 'Collusion Save File',
        version: '1.0',
        token: collusionToken,
        // connections: allConnections.map(function(connection){
        //     if (connection && connection.toLog){
        //         return connection.toLog();
        //     }else{
        //         log('Connection could not convert ' + JSON.stringify(connection) + ' to log format');
        //     }
        // })
    });
};

restore();

