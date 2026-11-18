#ifndef CONTROL_LOGIC_H
#define CONTROL_LOGIC_H

#include <stdbool.h>
#include <stdint.h>

#include "app_state.h"
#include "encoder.h"

typedef struct
{
    uint32_t now_ms;
    XbeeCommand_t xbee;
    RPiSample_t rpi;
    EncoderSample_t encoder;
} ControlLogicInput_t;

/* Which command link a target came from. */
/*
 * The rudder servo's pulse, in microseconds (TIM1 counts at 1 MHz): centred
 * at 1500 us less the linkage's 130 us trim, +/-400 us for +/-45 degrees, and
 * never outside the servo's 1000-2000 us.
 */
#define RUDDER_PWM_CENTRE_US 1370U
#define RUDDER_PWM_MIN_US 1000U
#define RUDDER_PWM_MAX_US 2000U

typedef enum
{
    CONTROL_SOURCE_NONE = 0, /* no fresh link: sail motor off, rudder centred */
    CONTROL_SOURCE_XBEE,
    CONTROL_SOURCE_RPI,
} ControlSource_t;

typedef struct
{
    bool xbee_valid;
    bool rpi_valid;
    float target_sail_angle;
    float target_rudder_angle;
    ControlSource_t sail_source;
    ControlSource_t rudder_source;
    uint16_t sail_motor_channel_1_pwm;
    uint16_t sail_motor_channel_2_pwm;
    uint16_t rudder_pwm;
} ControlLogicOutput_t;

void ControlLogic_Evaluate(const ControlLogicInput_t *input, ControlLogicOutput_t *output);

#endif /* CONTROL_LOGIC_H */
