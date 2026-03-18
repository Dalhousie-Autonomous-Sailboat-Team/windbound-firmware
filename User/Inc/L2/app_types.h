#ifndef APP_TYPES_H
#define APP_TYPES_H

#include <stdint.h>
#include <stdbool.h>


#include <stdint.h>
#include <stdbool.h>


// Struct to store $IIMWV NMEA sentence data
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

// Struct to store data from Xbee 
typedef struct
{
    float sail_angle;
    float rud_angle;
} MotorCommand_t;

typedef struct
{
    /* Targets (from autopilot) */
    float target_bearing;       /* degrees, East = 0,    [0, 360]      */
    float waypoint_lat;         /* degrees, Equator = 0, [-90, 90]     */
    float waypoint_lon;         /* degrees, Prime = 0,   [-180, 180]   */
    float target_sail_angle;    /* degrees, bow = 0,     [0, 360]      */
    float target_rudder_angle;  /* degrees, centre = 0,  [-45, 45]     */

    /* Navigation state */
    float current_lat;
    float current_lon;

    /* IMU */
    float pitch;
    float roll;
    float yaw;
} RPiSample_t;

#endif /* APP_TYPES_H */ /*** end of file ***/