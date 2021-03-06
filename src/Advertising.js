import getAdUnits from './utils/getAdUnits';
require('array.prototype.find').shim();

export default class Advertising {
    constructor(config, plugins = [], onError = () => {}) {
        this.config = config;
        this.slots = {};
        this.outOfPageSlots = {};
        this.plugins = plugins;
        this.onError = onError;
        this.gptSizeMappings = {};
        this.customEventCallbacks = {};
        this.customEventHandlers = {};
        this.queue = [];

        if (config) {
            this.setDefaultConfig();
        }
    }

    // ---------- PUBLIC METHODS ----------

    async setup() {
        this.initAmazon();
        this.setupAmazon();
        this.executePlugins('setup');
        const { slots, outOfPageSlots, queue } = this;
        this.setupCustomEvents();
        await Promise.all([
            Advertising.queueForPrebid(this.setupPrebid.bind(this), this.onError),
            Advertising.queueForGPT(this.setupGpt.bind(this), this.onError),
        ]);
        if (queue.length === 0) {
            return;
        }
        for (let i = 0; i < queue.length; i++) {
            const { id, customEventHandlers } = queue[i];
            Object.keys(customEventHandlers).forEach((customEventId) => {
                if (!this.customEventCallbacks[customEventId]) {
                    this.customEventCallbacks[customEventId] = {};
                }
                return (this.customEventCallbacks[customEventId][id] = customEventHandlers[customEventId]);
            });
        }
        const divIds = queue.map(({ id }) => id);
        const selectedSlots = queue.map(({ id }) => slots[id] || outOfPageSlots[id]);

        Advertising.queueForPrebid(
            () =>
                window.pbjs.requestBids({
                    adUnitCodes: divIds,
                    bidsBackHandler: () => {
                        window.pbjs.setTargetingForGPTAsync(divIds);
                        Advertising.queueForGPT(() => window.googletag.pubads().refresh(selectedSlots), this.onError);
                    },
                }),
            this.onError
        );
    }

    async teardown() {
        this.teardownCustomEvents();
        await Promise.all([
            Advertising.queueForPrebid(this.teardownPrebid.bind(this), this.onError),
            Advertising.queueForGPT(this.teardownGpt.bind(this), this.onError),
        ]);
        this.slots = {};
        this.gptSizeMappings = {};
        this.queue = {};
    }

    activate(id, customEventHandlers = {}) {
        // Bail if the component exists, but no config does.
        // This allows us to have components on page but we dont want to run the auction for it.
        if (!this.slots[id]) {
            return;
        }
        const { slots } = this;

        if (Object.values(slots).length === 0) {
            this.queue.push({ id, customEventHandlers });
            return;
        }
        Object.keys(customEventHandlers).forEach((customEventId) => {
            if (!this.customEventCallbacks[customEventId]) {
                this.customEventCallbacks[customEventId] = {};
            }
            return (this.customEventCallbacks[customEventId][id] = customEventHandlers[customEventId]);
        });

        let selectedSlot = null;
        this.config.slots.forEach(function (slot) {
            if (slot.id === id) {
                selectedSlot = slot;
            }
        });

        // APS request if its enabled for the unit.
        // Prebid will handle calling GPT. Amazon gets a chance to bid before.
        if (selectedSlot.amazon) {
            window.apstag.fetchBids(
                {
                    slots: [
                        {
                            slotID: id,
                            slotName: slots[id].getAdUnitPath(),
                            sizes: selectedSlot.sizes,
                        },
                    ],
                },
                function (bids) {
                    window.googletag.cmd.push(function () {
                        window.apstag.setDisplayBids();
                    });
                }
            );
        }

        Advertising.queueForPrebid(
            () =>
                window.pbjs.requestBids({
                    adUnitCodes: [id],
                    bidsBackHandler: () => {
                        window.pbjs.setTargetingForGPTAsync([id]);
                        Advertising.queueForGPT(() => window.googletag.pubads().refresh([slots[id]]), this.onError);
                    },
                }),
            this.onError
        );
    }

    isConfigReady() {
        return Boolean(this.config);
    }

    setConfig(config) {
        this.config = config;
        this.setDefaultConfig();
    }

    // ---------- PRIVATE METHODS ----------

    setupCustomEvents() {
        if (!this.config.customEvents) {
            return;
        }
        Object.keys(this.config.customEvents).forEach((customEventId) =>
            this.setupCustomEvent(customEventId, this.config.customEvents[customEventId])
        );
    }

    setupCustomEvent(customEventId, { eventMessagePrefix, divIdPrefix }) {
        const { customEventCallbacks } = this;
        this.customEventHandlers[customEventId] = ({ data }) => {
            if (typeof data !== 'string' || !data.startsWith(`${eventMessagePrefix}`)) {
                return;
            }
            const divId = `${divIdPrefix || ''}${data.substr(eventMessagePrefix.length)}`;
            const callbacks = customEventCallbacks[customEventId];
            if (!callbacks) {
                return;
            }
            const callback = callbacks[divId];
            if (callback) {
                callback();
            }
        };
        window.addEventListener('message', this.customEventHandlers[customEventId]);
    }

    teardownCustomEvents() {
        if (!this.config.customEvents) {
            return;
        }
        Object.keys(this.config.customEvents).forEach((customEventId) =>
            window.removeEventListener('message', this.customEventHandlers[customEventId])
        );
    }

    defineGptSizeMappings() {
        if (!this.config.sizeMappings) {
            return;
        }
        const entries = Object.entries(this.config.sizeMappings);
        for (let i = 0; i < entries.length; i++) {
            const [key, value] = entries[i];
            const sizeMapping = window.googletag.sizeMapping();
            for (let q = 0; q < value.length; q++) {
                const { viewPortSize, sizes } = value[q];
                sizeMapping.addSize(viewPortSize, sizes);
            }
            this.gptSizeMappings[key] = sizeMapping.build();
        }
    }

    getGptSizeMapping(sizeMappingName) {
        return sizeMappingName && this.gptSizeMappings[sizeMappingName] ? this.gptSizeMappings[sizeMappingName] : null;
    }

    defineSlots() {
        this.config.slots.forEach(({ id, path, collapseEmptyDiv, targeting = {}, sizes, sizeMappingName }) => {
            const sizeMapping = this.getGptSizeMapping(sizeMappingName);
            const slot = window.googletag.defineSlot(path || this.config.path, sizes, id);

            if (slot) {
                if (sizeMapping) {
                    slot.defineSizeMapping(sizeMapping);
                }

                if (collapseEmptyDiv && collapseEmptyDiv.length && collapseEmptyDiv.length > 0) {
                    slot.setCollapseEmptyDiv(...collapseEmptyDiv);
                }

                const entries = Object.entries(targeting);
                for (let i = 0; i < entries.length; i++) {
                    const [key, value] = entries[i];
                    slot.setTargeting(key, value);
                }

                slot.addService(window.googletag.pubads());

                this.slots[id] = slot;
            }
        });
    }

    defineOutOfPageSlots() {
        if (this.config.outOfPageSlots) {
            this.config.outOfPageSlots.forEach(({ id }) => {
                const slot = window.googletag.defineOutOfPageSlot(this.config.path, id);
                slot.addService(window.googletag.pubads());
                this.outOfPageSlots[id] = slot;
            });
        }
    }

    displaySlots() {
        this.executePlugins('displaySlots');
        this.config.slots.forEach(({ id }) => {
            window.googletag.display(id);
        });
    }

    displayOutOfPageSlots() {
        this.executePlugins('displayOutOfPageSlot');
        if (this.config.outOfPageSlots) {
            this.config.outOfPageSlots.forEach(({ id }) => {
                window.googletag.display(id);
            });
        }
    }

    setupPrebid() {
        this.executePlugins('setupPrebid');
        const adUnits = getAdUnits(this.config.slots);
        window.pbjs.addAdUnits(adUnits);
        window.pbjs.setConfig(this.config.prebid);
    }

    teardownPrebid() {
        this.executePlugins('teardownPrebid');
        getAdUnits(this.config.slots).forEach(({ code }) => window.pbjs.removeAdUnit(code));
    }

    initAmazon() {
        !(function (a9, a, p, s, t, A, g) {
            if (a[a9]) return;
            function q(c, r) {
                a[a9]._Q.push([c, r]);
            }
            a[a9] = {
                init() {
                    q('i', arguments);
                },
                fetchBids() {
                    q('f', arguments);
                },
                setDisplayBids() {},
                targetingKeys() {
                    return [];
                },
                _Q: [],
            };
            A = p.createElement(s);
            A.async = !0;
            A.src = t;
            g = p.getElementsByTagName(s)[0];
            g.parentNode.insertBefore(A, g);
        })('apstag', window, document, 'script', '//c.amazon-adsystem.com/aax2/apstag.js');
    }

    setupAmazon() {
        window.apstag.init({
            pubID: this.config.amazon.pubID,
            adServer: this.config.amazon.adServer,
        });
    }

    setupGpt() {
        this.executePlugins('setupGpt');
        const pubads = window.googletag.pubads();
        const { targeting } = this.config;
        this.defineGptSizeMappings();
        this.defineSlots();
        this.defineOutOfPageSlots();
        const entries = Object.entries(targeting);
        for (let i = 0; i < entries.length; i++) {
            const [key, value] = entries[i];
            pubads.setTargeting(key, value);
        }
        pubads.disableInitialLoad();

        if (this.config.gam.requestMode === 'SRA') {
            pubads.enableSingleRequest();
        }

        if (this.config.gam.lazyLoading) {
            window.googletag.pubads().enableLazyLoad(this.config.gam.lazyLoading);
        }

        window.googletag.enableServices();

        this.displaySlots();
        this.displayOutOfPageSlots();
    }

    teardownGpt() {
        this.executePlugins('teardownGpt');
        window.googletag.destroySlots();
    }

    setDefaultConfig() {
        if (!this.config.prebid) {
            this.config.prebid = {};
        }
        if (!this.config.metaData) {
            this.config.metaData = {};
        }
        if (!this.config.targeting) {
            this.config.targeting = {};
        }
    }

    executePlugins(method) {
        for (let i = 0; i < this.plugins.length; i++) {
            const func = this.plugins[i][method];
            if (func) {
                func.call(this);
            }
        }
    }

    static queueForGPT(func, onError) {
        return Advertising.withQueue(window.googletag.cmd, func, onError);
    }

    static queueForPrebid(func, onError) {
        return Advertising.withQueue(window.pbjs.que, func, onError);
    }

    static queueForAmazon(func, onError) {
        return Advertising.withQueue(window.apstag.init, func, onError);
    }

    static withQueue(queue, func, onError) {
        return new Promise((resolve) =>
            queue.push(() => {
                try {
                    func();
                    resolve();
                } catch (error) {
                    onError(error);
                }
            })
        );
    }
}
