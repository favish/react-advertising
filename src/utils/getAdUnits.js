export default (slots) =>
    slots
        .filter((slot) => slot.prebid)
        .reduce(
            (acc, currSlot) =>
                acc.concat(
                    currSlot.prebid.map((currPrebid) => ({
                        code: currSlot.id,
                        mediaTypes: currPrebid.mediaTypes,
                        bids: currPrebid.bids,
                    }))
                ),
            []
        );
