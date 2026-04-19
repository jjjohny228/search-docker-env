"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.KillSwitch = void 0;
class KillSwitch {
    constructor() {
        this.enabled = false;
    }
    activate() {
        this.enabled = true;
    }
    deactivate() {
        this.enabled = false;
    }
    isActive() {
        return this.enabled;
    }
}
exports.KillSwitch = KillSwitch;
