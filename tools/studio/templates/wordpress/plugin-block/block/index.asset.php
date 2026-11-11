<?php
/**
 * What the editor script needs (WordPress loads these before it). Raise "version" when
 * index.js changes, so browsers fetch the new file.
 */
return array(
	'dependencies' => array( 'wp-blocks', 'wp-element', 'wp-block-editor', 'wp-components', 'wp-i18n' ),
	'version'      => '{{VERSION}}',
);
