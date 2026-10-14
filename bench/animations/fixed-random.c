#include <stdint.h>

static uint32_t state = 7;

void arc4random_stir(void) {
    state = 7;
}

uint32_t arc4random(void) {
    state ^= state << 13;
    state ^= state >> 17;
    state ^= state << 5;
    return state;
}
