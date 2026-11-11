<?php
/**
 * {{NAME}} — theme functions.
 *
 * @package {{CLASS}}
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Theme set-up: what the theme supports.
 */
function {{PREFIX}}_setup() {
	add_theme_support( 'wp-block-styles' );
	add_theme_support( 'editor-styles' );
	add_editor_style( 'style.css' );
}
add_action( 'after_setup_theme', '{{PREFIX}}_setup' );

/**
 * The small rest of CSS that is not in theme.json.
 */
function {{PREFIX}}_styles() {
	wp_enqueue_style( '{{SLUG}}', get_stylesheet_uri(), array(), wp_get_theme()->get( 'Version' ) );
}
add_action( 'wp_enqueue_scripts', '{{PREFIX}}_styles' );
