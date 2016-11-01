"use strict";

var DevialetExpert       = require("node-devialet-expert"),
    RoonApi              = require("node-roon-api"),
    RoonApiSettings      = require('node-roon-api-settings'),
    RoonApiStatus        = require('node-roon-api-status'),
    RoonApiVolumeControl = require('node-roon-api-volume-control'),
    RoonApiSourceControl = require('node-roon-api-source-control');

var devialet = { rs232: new DevialetExpert() };

var roon = new RoonApi({
    extension_id:        'com.crieke.rotel.amp',
    display_name:        'Rotel Amp Volume and Source Control',
    display_version:     "1.0.0",
    publisher:           'Christopher Rieke',
    email:               'chris@rieke.tv',
    website:             'https://blog.rieke.tv',
});

var mysettings = roon.load_config("settings") || {
    serialport: "",
    source:     "USB",
};

function makelayout(settings) {
    var l = { 
        values:    settings,
	layout:    [],
	has_error: false
    };

    l.layout.push({
        type:      "string",
        title:     "Serial Port",
        maxlength: 256,
        setting:   "serialport",
    });

    l.layout.push({
        type:    "dropdown",
        title:   "Source for Convenience Switch",
        values:  [
            { value: "cd"       },
            { value: "coax1"   },
            { value: "coax2" },
            { value: "opt1" },
            { value: "opt2" },
            { value: "aux1" },
            { value: "aux2"   },
            { value: "tuner"    },
            { value: "phono"    },
            { value: "usb"     },
            { value: "pc_usb" },
            { value: "bal_xlr" },
            { value: "rcd"      },
        ],
        setting: "source",
    });

    return l;
}

var svc_settings = new RoonApiSettings(roon, {
    get_settings: function(cb) {
        cb(makelayout(mysettings));
    },
    save_settings: function(req, isdryrun, settings) {
	let l = makelayout(settings.values);
        req.send_complete(l.has_error ? "NotValid" : "Success", { settings: l });

        if (!isdryrun && !l.has_error) {
            var oldport = mysettings.serialport;
            mysettings = l.values;
            svc_settings.update_settings(l);
            if (oldport != mysettings.serialport) setup_serial_port(mysettings.serialport);
            roon.save_config("settings", mysettings);
        }
    }
});

var svc_status = new RoonApiStatus(roon);
var svc_volume_control = new RoonApiVolumeControl(roon);
var svc_source_control = new RoonApiSourceControl(roon);

roon.init_services({
    provided_services: [ svc_volume_control, svc_source_control, svc_settings, svc_status ]
});

function setup_serial_port(port) {
    devialet.rs232.stop();
    if (devialet.source_control)   { devialet.source_control.destroy();   delete(devialet.source_control);   }
    if (devialet.volume_control)   { devialet.volume_control.destroy();   delete(devialet.volume_control);   }

    if (port)
        devialet.rs232.start(port, 115200);
    else
        svc_status.set_status("Not configured, please check settings.", true);
}

devialet.rs232.on('status', ev_status);
devialet.rs232.on('changed', ev_changed);
setup_serial_port(mysettings.serialport);
    
function ev_status(status) {
    let rs232 = devialet.rs232;

    console.log("rotel rs232 status", status);

    if (status == "disconnected") {
        svc_status.set_status("Could not connect to Rotel Amp on \"" + mysettings.serialport + "\"", true);
        if (devialet.source_control) { devialet.source_control.destroy(); delete(devialet.source_control); }
        if (devialet.volume_control)   { devialet.volume_control.destroy();   delete(devialet.volume_control);   }

    } else if (status == "connected") {
        svc_status.set_status("Connected to Rotel Amp", false);
        devialet.source_control = svc_source_control.new_device({
            state: {
                display_name:     "Rotel Amp", // XXX need better less generic name -- can we get serial number from the RS232?
                supports_standby: true,
                status:           !rs232.properties.power ? "on" : (rs232.properties.source == mysettings.source ? "selected" : "deselected")
            },
    
            convenience_switch: function (req) {
                rs232.set_source(mysettings.source, err => { req.send_complete(err ? "Failed" : "Success"); });
                console.log("Setting Source!");
            },
            standby: function (req) {
                this.state.status = "standby";
                rs232.set_power("toggle", err => { req.send_complete(err ? "Failed" : "Success"); });
            }
        });

        devialet.volume_control = svc_volume_control.new_device({
            state: {
                display_name: "Rotel Amp", // XXX need better less generic name -- can we get serial number from the RS232?
                volume_type:  "db",
                volume_min:   1,
                volume_max:   96,
                volume_value: rs232.properties.volume,
                volume_step:  1,
                is_muted:     !!rs232.properties.mute
            },
            set_volume: function (req, mode, value) {
	            console.log("Setting ")
                let newvol = mode == "absolute" ? value : (rs232.properties.volume + value);
                if      (newvol < this.state.volume_min) newvol = this.state.volume_min;
                else if (newvol > this.state.volume_max) newvol = this.state.volume_max;
                rs232.set_volume(newvol, (err) => { req.send_complete(err ? "Failed" : "Success"); });
                console.log("setting volume");
            },
            set_mute: function (req, action) {
                console.log("Req: " + req + " Action: " + action);
                rs232.set_mute(action == "on" ? "on" : (action == "off" ? "off" : "toggle"),
                                (err) => { req.send_complete(err ? "Failed" : "Success"); });
            }
        });
    } 
}

function ev_changed(name, val) {
    let rs232 = devialet.rs232;
    if (name == "power" && !!rs232.properties.volume)
        console.log("Gerät wurde eingeschaltet");
    if (name == "volume" && devialet.volume_control)
        devialet.volume_control.update_state({ volume_value: val });
    else if (name == "mute"   && devialet.volume_control)
        devialet.volume_control.update_state({ is_muted: !!val });
    if ((name == "source" || name == "power") && devialet.source_control)
        devialet.source_control.update_state({ status: !rs232.properties.power ? "standby" : (val == mysettings.source ? "selected" : "deselected") });
}

roon.start_discovery();