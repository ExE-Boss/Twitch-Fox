(function() {
    var root = this;
    var that = {};
    var localStorage = require("sdk/simple-storage").storage

    function noop() {}

    that._adapters = {};

    var request = function(opts, callback) {
        if (root.require) {
            opts.method = opts.method.toLowerCase();
            var Request = require("sdk/request").Request;
            Request({
                url: opts.url,
                content: opts.data,
                onComplete: function(response) {
                    if (response.status == 200) {
                        callback(null, JSON.parse(response.text));
                    } else {
                        callback(response.status);
                    }
                }
            })[opts.method]()
        }
    }

    var Adapter = function(id, opts, flow) {
        this.lsPath = "oauth2_" + id;
        this.opts = opts;
        this.responseType = this.opts.response_type;
        this.secret = this.opts.client_secret;
        this.redirect = this.opts.redirect_uri.replace(/https*:\/\//i, "");
        delete this.opts.client_secret;
        this.flow = flow;
        this.codeUrl = opts.api + "?" + this.query(opts);
        this._watchInject();
    }

    Adapter.prototype._watchInject = function() {
        var self = this;
        var injectScript = '(' + this.injectScript.toString() + ')()';
        var injectTo;

        var pageMode = require("sdk/page-mod");

        injectTo = this.redirect + "*";

        //console.log("\n\n\nInjecting\n\n\n");
        pageMode.PageMod({
            include: ["https://" + injectTo, "http://" + injectTo],
            contentScript: injectScript,
            contentScriptWhen: "ready",
            attachTo: "top",
            onAttach: function(worker) {
                //console.log("\n\n\nattached to: " + worker.tab.url);
                worker.port.on("OAUTH2", function(msg) {
                    //console.log("\n\nAuth2 data :", msg)
                    self.finalize(msg.value.params);
                    worker.tab.close();
                });
            }
        });

    }

    Adapter.prototype.injectScript = function() {

        //console.log("\n\nInjecting\n\n");
        var self = window.self;

        var sendMessage = function(msg) {

            var data = {
                value: msg,
                type: "OAUTH2"
            };

            self.port.emit("OAUTH2", data);
        }

        var send = function() {

            var params = window.location.href;

            //console.log("\nSending back to background message = ", params);

            sendMessage({
                params: params
            });
        }

        send();

    }

    Adapter.prototype.del = function( /*keys*/ ) {
        delete localStorage[this.lsPath];
    }

    Adapter.prototype.get = function() {
        return typeof localStorage[this.lsPath] != "undefined" ?
            JSON.parse(localStorage[this.lsPath]) :
            undefined;
    }

    Adapter.prototype.set = function(val, passSync) {
        localStorage[this.lsPath] = JSON.stringify(val);
    }

    Adapter.prototype.updateLocalStorage = function() {
        var stored = this.get();
        stored = stored || {
            accessToken: ""
        };
        stored.accessToken = stored.accessToken || "";
        this.set(stored);
    }


    Adapter.prototype.pick = function(obj, params) {
        var res = {};
        for (var i in obj) {
            if (~params.indexOf(i) && obj.hasOwnProperty(i)) {
                res[i] = obj[i];
            }
        }
        return res;
    }

    Adapter.prototype.query = function(o) {
        var res = [];
        for (var i in o) {
            res.push(encodeURIComponent(i) + "=" + encodeURIComponent(o[i]));
        }
        return res.join("&");
    }

    Adapter.prototype.parseAccessToken = function(url) {
        var error = url.match(/[&\?]error=([^&]+)/);
        if (error) {
            throw new Error('Error getting access token: ' + error[1]);
        }
        return url.match(/[&#]access_token=([\w\/\-]+)/)[1];
    }

    Adapter.prototype.parseAuthorizationCode = function(url) {
        var error = url.match(/[&\?]error=([^&]+)/);
        if (error) {
            throw new Error('Error getting authorization code: ' + error[1]);
        }
        return url.match(/[&\?]code=([\w\/\-]+)/)[1];
    }

    Adapter.prototype.authorize = function(callback) {
        this._callback = callback;
        this.openTab(this.codeUrl);
    }

    Adapter.prototype.finalize = function(params) {
        var self = this;
        var callback = self._callback || noop;
        var code;
        var token;

        //console.log("\nSelf response type", self.responseType);
        if (self.responseType == "code") {
            try {
                code = this.parseAuthorizationCode(params);
            } catch (err) {
                //console.log("\n\nerror parsing auth code\n\n");
                return callback(err);
            }

            this.getAccessAndRefreshTokens(code, function(err, data) {
                if (!err) {
                    //console.log("\n\nRecieve access token = ", data.access_token);
                    self.setAccessToken(data.access_token);
                    callback();
                } else {
                    callback(err);
                }
            })
        }

        if (self.responseType == "token") {
            try {
                self.setAccessToken(self.parseAccessToken(params));
            } catch (err) {
                return callback(err);
            }
            callback();
        }
    }

    Adapter.prototype.getAccessAndRefreshTokens = function(authorizationCode, callback) {

        var method = this.flow.method;
        var url = this.flow.url;
        var data = this.opts;

        data["grant_type"] = "authorization_code";
        data["code"] = authorizationCode;
        data["client_secret"] = this.secret;

        var values = this.pick(data, ["client_id", "client_secret", "grant_type", "redirect_uri", "code"]);

        request({
            url: url,
            method: method,
            data: values
        }, callback)
    }

    Adapter.prototype.openTab = function(url) {
        var tabs = require('sdk/tabs');

        tabs.open({
            url: url
        });
    }

    Adapter.prototype.setAccessToken = function(token) {
        this.set({
            accessToken: token
        });
    }

    Adapter.prototype.hasAccessToken = function() {
        var g = this.get();
        return g && g.hasOwnProperty("accessToken");
    }

    Adapter.prototype.getAccessToken = function() {
        return this.hasAccessToken() ? this.get().accessToken : "";
    }

    Adapter.prototype.clearAccessToken = function() {
        //console.log("clear access token");
        var data = this.get();
        delete data.accessToken;
        this.set(data);
    }

    that.lookupAdapter = function(url) {
        //console.log("lookup adapter for url = ", url);
        var adapters = that._adapters;
        for (var i in adapters) {
            if (adapters[i].opts.redirect_uri == url) {
                return adapters[i];
            }
        }
    }

    that.addAdapter = function(opts) {
        var id = opts.id;
        var adapter = that._adapters[id];
        if (!adapter) {
            adapter = that._adapters[id] = new Adapter(id, opts.opts, opts.codeflow);
        }
        return adapter;
    }

    if (typeof exports !== 'undefined') {
        if (typeof module !== 'undefined' && module.exports) {
            exports = module.exports = that;
        }
        exports.OAuth2 = that;
    } else {
        root.OAuth2 = that;
    }

}).call(this);