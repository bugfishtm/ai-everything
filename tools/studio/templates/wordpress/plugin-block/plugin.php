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

/**
 * Registers the block from block.json. The editor script is plain JavaScript (no build step):
 * it uses the wp.* globals WordPress loads in the editor.
 */
function {{PREFIX}}_register_block() {
	register_block_type( __DIR__ . '/block' );
}
add_action( 'init', '{{PREFIX}}_register_block' );
