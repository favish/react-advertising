import getAdUnits from './utils/getAdUnits';
import getAmazonAdUnits from './utils/getAmazonAdUnits';
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

        this.fetchHeaderBiddersInParallel(divIds, selectedSlots);
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

    validForViewport(sizeMapping) {
        const viewportHeight = window.innerHeight;
        const viewportWidth = window.innerWidth;

        // Search the size mapping array for the first hit that fits the current viewport, working from top.
        const result = sizeMapping.find(function (mapping) {
            return viewportWidth >= mapping[0][0] && viewportHeight >= mapping[0][1];
        });

        // Ensure that the matched viewport has a size defined, else that unit should not be defined at this viewport.
        if (result[1].length) {
            return true;
        }

        return false;
    }

    defineSlots() {
        this.config.slots.forEach(({ id, path, collapseEmptyDiv, targeting = {}, sizes, sizeMappingName }) => {
            const sizeMapping = this.getGptSizeMapping(sizeMappingName);
            let slot = false;

            if (!sizeMapping) {
                slot = window.googletag.defineSlot(path || this.config.path, sizes, id);
            } else if (this.validForViewport(sizeMapping)) {
                console.log(id + ' is valid for this viewport');
                slot = window.googletag.defineSlot(path || this.config.path, sizes, id);
            }

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

    fetchHeaderBiddersInParallel(divIds, selectedSlots) {
        const amazonAdUnits = getAmazonAdUnits(this.config.slots);
        const FAILSAFE_TIMEOUT = this.config.globalFailSafeTimeout;
        const requestManager = {
            adserverRequestSent: false,
            aps: false,
            prebid: false,
        };

        // When both APS and Prebid have returned, initiate ad request
        function biddersBack() {
            if (requestManager.aps && requestManager.prebid) {
                sendAdserverRequest();
            }
            return;
        }

        function sendAdserverRequest() {
            if (requestManager.adserverRequestSent === true) {
                return;
            }
            requestManager.adserverRequestSent = true;
            window.googletag.cmd.push(function () {
                window.googletag.pubads().refresh();
            });
        }

        // Request bids from both Amazon and Prebid.
        function requestHeaderBids() {
            // Amazon request
            window.apstag.fetchBids(
                {
                    slots: amazonAdUnits,
                },
                function () {
                    window.googletag.cmd.push(function () {
                        window.apstag.setDisplayBids();
                        requestManager.aps = true; // Signals that APS request has completed
                        biddersBack(); // Checks whether both APS and Prebid have returned
                    });
                }
            );

            // Prebid Request
            window.pbjs.que.push(function () {
                window.pbjs.requestBids({
                    bidsBackHandler() {
                        window.googletag.cmd.push(function () {
                            window.pbjs.setTargetingForGPTAsync();
                            requestManager.prebid = true; // Signals that Prebid request has completed
                            biddersBack(); // Checks whether both APS and Prebid have returned
                        });
                    },
                });
            });

            Advertising.queueForPrebid(() =>
                window.pbjs.requestBids({
                    adUnitCodes: divIds,
                    bidsBackHandler: () => {
                        window.pbjs.setTargetingForGPTAsync(divIds);
                        Advertising.queueForGPT(() => window.googletag.pubads().refresh(selectedSlots), this.onError);
                    },
                })
            );
        }

        // Initiate bid request
        requestHeaderBids();

        // Set failsafe timeout
        window.setTimeout(function () {
            sendAdserverRequest();
        }, FAILSAFE_TIMEOUT);
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
