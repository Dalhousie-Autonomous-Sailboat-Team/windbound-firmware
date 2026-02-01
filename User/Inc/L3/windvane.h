#ifndef WINDVANE_H
#define WINDVANE_H

#include <stdint.h>
#include <stdbool.h>

#define WIND_BUF_SIZE 8

typedef struct
{
    float direction; // in degrees
    char reference;  // 'R' for relative, 'T' for true
    float speed;
    char speed_unit; // 'K' for km/h, 'M' for m/s, 'N' for knots
    char status;     // 'A' for valid, 'V' for invalid
    char checksum[3]; // two hex digits + null terminator
    uint32_t timestamp;

} WindSample_t;

typedef struct
{
    WindSample_t wind_buf[WIND_BUF_SIZE];
    volatile uint8_t head;
    volatile int8_t tail;
} WindVaneCircBuf_t;

extern WindVaneCircBuf_t wind_vane_buffer;

#endif /* WINDVANE_H */ /*** end of file ***/