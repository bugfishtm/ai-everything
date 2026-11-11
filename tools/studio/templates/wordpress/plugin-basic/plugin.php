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
	exit; // no direct access
}

define( '{{CONST}}_VERSION', '{{VERSION}}' );
define( '{{CONST}}_DIR', plugin_dir_path( __FILE__ ) );
define( '{{CONST}}_URL', plugin_dir_url( __FILE__ ) );

/**
 * Runs once when the plugin is activated: create options, tables, rewrite rules here.
 */
function {{PREFIX}}_activate() {
	add_option( '{{PREFIX}}_version', {{CONST}}_VERSION );
}
register_activation_hook( __FILE__, '{{PREFIX}}_activate' );

/**
 * Runs when the plugin is deactivated (the data stays — it is removed in uninstall.php).
 */
function {{PREFIX}}_deactivate() {
	// e.g. wp_clear_scheduled_hook( '{{PREFIX}}_daily' );
}
register_deactivation_hook( __FILE__, '{{PREFIX}}_deactivate' );

/**
 * Front-end styles and scripts.
 */
function {{PREFIX}}_assets() {
	wp_enqueue_style( '{{SLUG}}', {{CONST}}_URL . 'assets/style.css', array(), {{CONST}}_VERSION );
}
add_action( 'wp_enqueue_scripts', '{{PREFIX}}_assets' );

/**
 * [{{SLUG}} title="Hello"] — a first shortcode to build on.
 *
 * @param array|string $atts Shortcode attributes.
 * @return string HTML.
 */
function {{PREFIX}}_shortcode( $atts ) {
	$atts = shortcode_atts(
		array(
			'title' => __( 'Hello from {{NAME}}', '{{SLUG}}' ),
		),
		$atts,
		'{{SLUG}}'
	);
	return sprintf( '<div class="{{SLUG}}"><strong>%s</strong></div>', esc_html( $atts['title'] ) );
}
add_shortcode( '{{SLUG}}', '{{PREFIX}}_shortcode' );
