<?php
/**
 * Runs when the plugin is deleted in WordPress: remove everything it stored.
 *
 * @package {{CLASS}}
 */

if ( ! defined( 'WP_UNINSTALL_PLUGIN' ) ) {
	exit;
}

delete_option( '{{PREFIX}}_settings' );
