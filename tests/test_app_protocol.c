#include "app_protocol.h"
#include "test_harness.h"

#include <string.h>

static const char *valid_rpi_packet =
    "{\"TargetsOutput\":[{"
    "\"targetBearing\":91.5,"
    "\"waypointLat\":44.25,"
    "\"waypointLon\":-63.75,"
    "\"targetSailAngle\":25.5,"
    "\"targetFlapAngle\":3.0,"
    "\"targetRudderAngle\":-12.5,"
    "\"latitude\":44.6,"
    "\"longitude\":-63.6,"
    "\"headingAngle\":180.0,"
    "\"windAngle\":42.25"
    "}]}";

static void string_to_float_handles_sign_and_precision(void)
{
    TEST_EXPECT_FLOAT_NEAR(226.0f, StringToFloat("226.0"), 0.0001f);
    TEST_EXPECT_FLOAT_NEAR(-12.5f, StringToFloat("-12.5"), 0.0001f);
    TEST_EXPECT_FLOAT_NEAR(1.2345f, StringToFloat("+1.23456"), 0.0001f);
    TEST_EXPECT_FLOAT_NEAR(0.0f, StringToFloat(NULL), 0.0001f);
    TEST_EXPECT_FLOAT_NEAR(0.0f, StringToFloat("not-a-number"), 0.0001f);
}

static void string_to_float_keeps_precision_and_exponents(void)
{
    /* Positions need metres: 0.00001 degrees of latitude is 1.1 m. */
    TEST_EXPECT_FLOAT_NEAR(44.692512f, StringToFloat("44.692512"), 0.000005f);
    TEST_EXPECT_FLOAT_NEAR(-63.553012f, StringToFloat("-63.553012"), 0.000005f);
    /* Python writes small numbers with an exponent. */
    TEST_EXPECT_FLOAT_NEAR(0.000012f, StringToFloat("1.2e-05"), 0.0000001f);
    TEST_EXPECT_FLOAT_NEAR(1500.0f, StringToFloat("1.5E+3"), 0.001f);
    TEST_EXPECT_FLOAT_NEAR(-0.5f, StringToFloat("-5e-1"), 0.000001f);
}

static void sensor_input_reports_speed_and_validity(void)
{
    WindSample_t wind = {87.6f, 'R', 8.0f, 'N', 'A', "00", 1000U};
    char buffer[128];

    TEST_EXPECT_TRUE(AppProtocol_FormatSensorInput(buffer, sizeof(buffer), &wind, 1500U));
    /* 8 knots is 4.1 m/s; the angle stays a whole number, as before. */
    TEST_EXPECT_STRING("{\"SensorInput\":[{\"windAngle\":87,\"windSpeed\":4.1,"
                       "\"windRef\":\"R\",\"windValid\":1}]}\r\n", buffer);

    /* Stale, flagged invalid by the vane, or never heard: not valid. */
    TEST_EXPECT_TRUE(AppProtocol_FormatSensorInput(buffer, sizeof(buffer), &wind,
                                                   1000U + WIND_STALE_MS));
    TEST_EXPECT_TRUE(strstr(buffer, "\"windValid\":0") != NULL);
    wind.status = 'V';
    TEST_EXPECT_TRUE(AppProtocol_FormatSensorInput(buffer, sizeof(buffer), &wind, 1500U));
    TEST_EXPECT_TRUE(strstr(buffer, "\"windValid\":0") != NULL);
    WindSample_t never = {0};
    TEST_EXPECT_TRUE(AppProtocol_FormatSensorInput(buffer, sizeof(buffer), &never, 1500U));
    TEST_EXPECT_TRUE(strstr(buffer, "\"windValid\":0") != NULL);

    char small[16];
    TEST_EXPECT_FALSE(AppProtocol_FormatSensorInput(small, sizeof(small), &wind, 1500U));
}

static void float_to_string_rounds_to_nearest_integer(void)
{
    char buffer[16];

    FloatToString(12.6f, buffer);
    TEST_EXPECT_STRING("13", buffer);

    FloatToString(-12.6f, buffer);
    TEST_EXPECT_STRING("-13", buffer);
}

static void xbee_parser_extracts_signed_commands(void)
{
    XbeeCommand_t command = {0};

    bool parsed = AppProtocol_ParseXbeeCommand("{sa:30.5,ra:-12.25}\n", &command);

    TEST_EXPECT_TRUE(parsed);
    TEST_EXPECT_FLOAT_NEAR(30.5f, command.sail_angle, 0.0001f);
    TEST_EXPECT_FLOAT_NEAR(-12.25f, command.rud_angle, 0.0001f);
}

static void xbee_parser_rejects_incomplete_packets(void)
{
    XbeeCommand_t command = {0};

    TEST_EXPECT_FALSE(AppProtocol_ParseXbeeCommand("{sa:30.5}", &command));
    TEST_EXPECT_FALSE(AppProtocol_ParseXbeeCommand("sa:30.5,ra:1}", &command));
    TEST_EXPECT_FALSE(AppProtocol_ParseXbeeCommand(NULL, &command));
    TEST_EXPECT_FALSE(AppProtocol_ParseXbeeCommand("{sa:1,ra:2}", NULL));
}

static void rpi_parser_extracts_all_fields(void)
{
    RPiSample_t sample = {0};

    bool parsed = AppProtocol_ParseRpiSample(valid_rpi_packet, &sample);

    TEST_EXPECT_TRUE(parsed);
    TEST_EXPECT_FLOAT_NEAR(91.5f, sample.target_bearing, 0.0001f);
    TEST_EXPECT_FLOAT_NEAR(44.25f, sample.target_lat, 0.0001f);
    TEST_EXPECT_FLOAT_NEAR(-63.75f, sample.target_lon, 0.0001f);
    TEST_EXPECT_FLOAT_NEAR(25.5f, sample.target_sail_angle, 0.0001f);
    TEST_EXPECT_FLOAT_NEAR(3.0f, sample.target_flap_angle, 0.0001f);
    TEST_EXPECT_FLOAT_NEAR(-12.5f, sample.target_rudder_angle, 0.0001f);
    TEST_EXPECT_FLOAT_NEAR(44.6f, sample.current_lat, 0.0001f);
    TEST_EXPECT_FLOAT_NEAR(-63.6f, sample.current_lon, 0.0001f);
    TEST_EXPECT_FLOAT_NEAR(180.0f, sample.current_bearing, 0.0001f);
    TEST_EXPECT_FLOAT_NEAR(42.25f, sample.current_wind_angle, 0.0001f);
}

static void rpi_parser_rejects_missing_required_field(void)
{
    RPiSample_t sample = {0};
    const char *missing_wind =
        "{\"TargetsOutput\":[{"
        "\"targetBearing\":1,\"waypointLat\":2,\"waypointLon\":3,"
        "\"targetSailAngle\":4,\"targetFlapAngle\":5,\"targetRudderAngle\":6,"
        "\"latitude\":7,\"longitude\":8,\"headingAngle\":9}]}";

    TEST_EXPECT_FALSE(AppProtocol_ParseRpiSample(missing_wind, &sample));
}

static void wind_parser_extracts_iimwv_fields(void)
{
    WindSample_t sample = {0};

    bool parsed = AppProtocol_ParseWindNmea("$IIMWV,123.4,R,5.6,N,A*2F\r\n", &sample);

    TEST_EXPECT_TRUE(parsed);
    TEST_EXPECT_FLOAT_NEAR(123.4f, sample.direction, 0.0001f);
    TEST_EXPECT_INT('R', sample.reference);
    TEST_EXPECT_FLOAT_NEAR(5.6f, sample.speed, 0.0001f);
    TEST_EXPECT_INT('N', sample.speed_unit);
    TEST_EXPECT_INT('A', sample.status);
}

static void wind_parser_rejects_wrong_sentence_type(void)
{
    WindSample_t sample = {0};
    TEST_EXPECT_FALSE(AppProtocol_ParseWindNmea("$GPGGA,1,2,3", &sample));
    TEST_EXPECT_FALSE(AppProtocol_ParseWindNmea(NULL, &sample));
    TEST_EXPECT_FALSE(AppProtocol_ParseWindNmea("$IIMWV,1,R,2,N,A*00", NULL));
}

static void telemetry_formats_ground_station_line(void)
{
    RPiSample_t rpi = {0};
    rpi.target_bearing = 91.5f;
    rpi.target_lat = 44.6912f;
    rpi.target_lon = -63.5512f;
    rpi.target_sail_angle = 25.5f;
    rpi.target_flap_angle = 3.0f;
    rpi.target_rudder_angle = -12.5f;
    rpi.current_lat = 44.6901f;
    rpi.current_lon = -63.5543f;
    rpi.current_bearing = 180.0f;
    rpi.current_wind_angle = 42.25f;
    EncoderSample_t sail_enc = {4U, 213U};
    char buffer[256];

    /* Characterizes today's format: integer fields and a trailing comma. */
    TEST_EXPECT_TRUE(AppProtocol_FormatTelemetry(buffer, sizeof(buffer), &rpi, &sail_enc));
    TEST_EXPECT_STRING("{\"tb\":91,\"tlat\":44,\"tlon\":-63,\"tsa\":25,\"tfa\":3,\"tra\":-12,"
                       "\"clat\":44,\"clon\":-63,\"cb\":180,\"wa\":42,\"sa\":213,}\r\n",
                       buffer);
}

static void telemetry_reports_short_buffer(void)
{
    RPiSample_t rpi = {0};
    EncoderSample_t sail_enc = {4U, 180U};
    char buffer[16];

    TEST_EXPECT_FALSE(AppProtocol_FormatTelemetry(buffer, sizeof(buffer), &rpi, &sail_enc));
    TEST_EXPECT_FALSE(AppProtocol_FormatTelemetry(buffer, sizeof(buffer), NULL, &sail_enc));
}

int main(void)
{
    TestHarness_Run("string-to-float handles sign and precision",
                    string_to_float_handles_sign_and_precision);
    TestHarness_Run("string-to-float keeps precision and exponents",
                    string_to_float_keeps_precision_and_exponents);
    TestHarness_Run("float-to-string rounds", float_to_string_rounds_to_nearest_integer);
    TestHarness_Run("sensor input reports speed and validity",
                    sensor_input_reports_speed_and_validity);
    TestHarness_Run("XBee parser extracts commands", xbee_parser_extracts_signed_commands);
    TestHarness_Run("XBee parser rejects incomplete packets",
                    xbee_parser_rejects_incomplete_packets);
    TestHarness_Run("RPi parser extracts all fields", rpi_parser_extracts_all_fields);
    TestHarness_Run("RPi parser rejects missing required fields",
                    rpi_parser_rejects_missing_required_field);
    TestHarness_Run("wind parser extracts IIMWV fields", wind_parser_extracts_iimwv_fields);
    TestHarness_Run("wind parser rejects wrong sentence type",
                    wind_parser_rejects_wrong_sentence_type);
    TestHarness_Run("telemetry formats ground station line",
                    telemetry_formats_ground_station_line);
    TestHarness_Run("telemetry reports short buffer", telemetry_reports_short_buffer);
    return TestHarness_Finish();
}
