export default (slots) => {
    const amazonEnabledSlots = slots.filter((slot) => slot.amazon);
    const amazonBuiltSlots = amazonEnabledSlots.map((slot) => {
        return {
            slotID: slot.id,
            slotName: slot.path,
            sizes: slot.sizes,
        };
    });

    return amazonBuiltSlots;
};
