<?php
/**
 * The bottom of every page.
 *
 * @package {{CLASS}}
 */

?>
</main>
<footer class="site-footer">
	<?php if ( is_active_sidebar( 'footer' ) ) : ?>
		<?php dynamic_sidebar( 'footer' ); ?>
	<?php endif; ?>
	<p>&copy; <?php echo esc_html( gmdate( 'Y' ) ); ?> <?php bloginfo( 'name' ); ?></p>
</footer>
<?php wp_footer(); ?>
</body>
</html>
