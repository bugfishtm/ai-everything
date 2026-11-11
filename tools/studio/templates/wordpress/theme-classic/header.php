<?php
/**
 * The top of every page.
 *
 * @package {{CLASS}}
 */

?><!doctype html>
<html <?php language_attributes(); ?>>
<head>
	<meta charset="<?php bloginfo( 'charset' ); ?>">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<?php wp_head(); ?>
</head>
<body <?php body_class(); ?>>
<?php wp_body_open(); ?>
<a class="screen-reader-text" href="#content"><?php esc_html_e( 'Skip to content', '{{SLUG}}' ); ?></a>
<header class="site-header">
	<p class="site-title"><a href="<?php echo esc_url( home_url( '/' ) ); ?>" rel="home"><?php bloginfo( 'name' ); ?></a></p>
	<nav class="site-nav" aria-label="<?php esc_attr_e( 'Main menu', '{{SLUG}}' ); ?>">
		<?php
		wp_nav_menu(
			array(
				'theme_location' => 'primary',
				'container'      => false,
				'fallback_cb'    => false,
				'depth'          => 1,
			)
		);
		?>
	</nav>
</header>
<main id="content" class="site-main">
