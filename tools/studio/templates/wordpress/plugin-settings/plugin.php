<?php
/**
 * Plugin Name:       {{NAME}}
 * Description:       {{DESCRIPTION}}
 * Version:           {{VERSION}}
 * Requires at least: 6.4
 * Requires PHP:      7.4
 * Author:            {{AUTHOR}}
 * License:           GPL-2.0-or-later
 * Text Domain:       {{SLUG}}
 * Update URI:        false
 *
 * @package {{CLASS}}
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( '{{CONST}}_VERSION', '{{VERSION}}' );
define( '{{CONST}}_OPTION', '{{PREFIX}}_settings' );

/**
 * The plugin's settings with their defaults.
 *
 * @return array
 */
function {{PREFIX}}_settings() {
	$defaults = array(
		'enabled' => 1,
		'message' => __( 'Thanks for visiting!', '{{SLUG}}' ),
		'color'   => '#2563eb',
	);
	return wp_parse_args( get_option( {{CONST}}_OPTION, array() ), $defaults );
}

/**
 * Settings → {{NAME}}.
 */
function {{PREFIX}}_admin_menu() {
	add_options_page(
		__( '{{NAME}}', '{{SLUG}}' ),
		__( '{{NAME}}', '{{SLUG}}' ),
		'manage_options',
		'{{SLUG}}',
		'{{PREFIX}}_render_page'
	);
}
add_action( 'admin_menu', '{{PREFIX}}_admin_menu' );

/**
 * Registers the option, its section and its fields (Settings API: WordPress saves and
 * checks the nonce and the capability itself).
 */
function {{PREFIX}}_register_settings() {
	register_setting(
		'{{PREFIX}}_group',
		{{CONST}}_OPTION,
		array(
			'type'              => 'array',
			'sanitize_callback' => '{{PREFIX}}_sanitize',
		)
	);
	add_settings_section( '{{PREFIX}}_main', __( 'General', '{{SLUG}}' ), '__return_false', '{{SLUG}}' );
	add_settings_field( 'enabled', __( 'Show the message', '{{SLUG}}' ), '{{PREFIX}}_field_enabled', '{{SLUG}}', '{{PREFIX}}_main' );
	add_settings_field( 'message', __( 'Message', '{{SLUG}}' ), '{{PREFIX}}_field_message', '{{SLUG}}', '{{PREFIX}}_main' );
	add_settings_field( 'color', __( 'Color', '{{SLUG}}' ), '{{PREFIX}}_field_color', '{{SLUG}}', '{{PREFIX}}_main' );
}
add_action( 'admin_init', '{{PREFIX}}_register_settings' );

/**
 * Cleans what the form sent before it is stored.
 *
 * @param mixed $input Raw form values.
 * @return array
 */
function {{PREFIX}}_sanitize( $input ) {
	$input = is_array( $input ) ? $input : array();
	$color = isset( $input['color'] ) ? sanitize_hex_color( $input['color'] ) : '';
	return array(
		'enabled' => empty( $input['enabled'] ) ? 0 : 1,
		'message' => isset( $input['message'] ) ? sanitize_text_field( $input['message'] ) : '',
		'color'   => $color ? $color : '#2563eb',
	);
}

function {{PREFIX}}_field_enabled() {
	$s = {{PREFIX}}_settings();
	printf(
		'<label><input type="checkbox" name="%1$s[enabled]" value="1" %2$s> %3$s</label>',
		esc_attr( {{CONST}}_OPTION ),
		checked( 1, (int) $s['enabled'], false ),
		esc_html__( 'Below every post', '{{SLUG}}' )
	);
}

function {{PREFIX}}_field_message() {
	$s = {{PREFIX}}_settings();
	printf( '<input type="text" class="regular-text" name="%s[message]" value="%s">', esc_attr( {{CONST}}_OPTION ), esc_attr( $s['message'] ) );
}

function {{PREFIX}}_field_color() {
	$s = {{PREFIX}}_settings();
	printf( '<input type="color" name="%s[color]" value="%s">', esc_attr( {{CONST}}_OPTION ), esc_attr( $s['color'] ) );
}

function {{PREFIX}}_render_page() {
	if ( ! current_user_can( 'manage_options' ) ) {
		return;
	}
	?>
	<div class="wrap">
		<h1><?php echo esc_html( get_admin_page_title() ); ?></h1>
		<form action="options.php" method="post">
			<?php
			settings_fields( '{{PREFIX}}_group' );
			do_settings_sections( '{{SLUG}}' );
			submit_button();
			?>
		</form>
	</div>
	<?php
}

/**
 * "Settings" link in the plugin list.
 *
 * @param array $links Existing links.
 * @return array
 */
function {{PREFIX}}_action_links( $links ) {
	array_unshift( $links, sprintf( '<a href="%s">%s</a>', esc_url( admin_url( 'options-general.php?page={{SLUG}}' ) ), esc_html__( 'Settings', '{{SLUG}}' ) ) );
	return $links;
}
add_filter( 'plugin_action_links_' . plugin_basename( __FILE__ ), '{{PREFIX}}_action_links' );

/**
 * The front-end output: the message below the content of single posts.
 *
 * @param string $content Post content.
 * @return string
 */
function {{PREFIX}}_append_message( $content ) {
	$s = {{PREFIX}}_settings();
	if ( ! $s['enabled'] || '' === $s['message'] || ! is_singular( 'post' ) || ! in_the_loop() || ! is_main_query() ) {
		return $content;
	}
	return $content . sprintf(
		'<p class="{{SLUG}}-message" style="border-left:4px solid %1$s;padding-left:.75em">%2$s</p>',
		esc_attr( $s['color'] ),
		esc_html( $s['message'] )
	);
}
add_filter( 'the_content', '{{PREFIX}}_append_message' );
