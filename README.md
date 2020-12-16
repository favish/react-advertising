# react-advertising

This is a forked, modified version of react-advertising (https://www.npmjs.com/package/react-advertising).

Modifications include adding Amazon TAM bidding in parallel, making header bidding optional, and adding
additional configuration for ad units to handle min/max widths and other features.

A JavaScript library for display ads in [React](https://reactjs.org) applications.

**Integrate ads in your app the “React way”: by adding ad components to your JSX layout!**

* One central configuration file for all your GPT and Prebid placement config
* One provider component that handles all the “plumbing” with *googletag* and *pbjs*, nicely hidden away
* Ad slot components that get filled with creatives from the ad server when they mount to the DOM
* Works well in single page applications with multiple routes
* Suitable for server-side-rendering

[![Build Status](https://travis-ci.com/technology-ebay-de/react-advertising.svg?branch=master)](https://travis-ci.com/technology-ebay-de/react-advertising) [![Coverage Status](https://coveralls.io/repos/github/technology-ebay-de/react-advertising/badge.svg?branch=master)](https://coveralls.io/github/technology-ebay-de/react-advertising?branch=master)

## Prerequisites

To use *react-advertising*, you need to have a [Doubleclick for Publishers](https://www.google.com/intl/en/doubleclick/publishers/welcome/)
(DFP) ad server set up, along with configuration to use Prebid in place. Please refer to the
[Prebid documentation](http://prebid.org/overview/intro.html) for details.

The demo uses the same test Prebid configuration as the
[code examples from the official documentation](http://prebid.org/dev-docs/examples/basic-example.html).


## License

[MIT licensed](LICENSE)

Copyright © 2018-2020 mobile.de GmbH
