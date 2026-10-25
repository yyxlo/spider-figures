import io
import re
from pathlib import Path

from django.conf import settings
from django.core.files.base import ContentFile
from django.db import models
from django.urls import reverse
from PIL import Image, ImageOps

THUMB_SIZE = 360
MEDIUM_SIZE = 1400
INITIALS_RE = re.compile(r"^(?:[A-ZÀ-Þ][a-zà-ÿ]?\.\s*-?\s*)+$")


class Family(models.Model):
    name = models.CharField("科名", max_length=100, unique=True)
    author = models.CharField("命名者", max_length=200, blank=True)
    common_name = models.CharField("中文名", max_length=100, blank=True)
    wsc_lsid = models.CharField("WSC LSID", max_length=120, blank=True, db_index=True)

    class Meta:
        ordering = ["name"]
        verbose_name = verbose_name_plural = "科"

    def __str__(self):
        return self.name

    def get_absolute_url(self):
        return reverse("family_detail", args=[self.pk])


class Genus(models.Model):
    family = models.ForeignKey(Family, on_delete=models.PROTECT, related_name="genera", verbose_name="科")
    name = models.CharField("屬名", max_length=100, unique=True)
    author = models.CharField("命名者", max_length=200, blank=True)
    common_name = models.CharField("中文名", max_length=100, blank=True)
    wsc_lsid = models.CharField("WSC LSID", max_length=120, blank=True, db_index=True)

    class Meta:
        ordering = ["name"]
        verbose_name = verbose_name_plural = "屬"

    def __str__(self):
        return self.name

    def get_absolute_url(self):
        return reverse("genus_detail", args=[self.pk])


class Species(models.Model):
    genus = models.ForeignKey(Genus, on_delete=models.PROTECT, related_name="species", verbose_name="屬")
    epithet = models.CharField("種小名", max_length=100)
    subspecies = models.CharField("亞種名", max_length=100, blank=True)
    author = models.CharField("命名者與年代", max_length=200, blank=True,
                              help_text="例如 (Thorell, 1890)")
    common_name = models.CharField("中文名", max_length=100, blank=True)
    wsc_lsid = models.CharField("WSC LSID", max_length=120, blank=True, db_index=True)
    valid_species = models.ForeignKey(
        "self", on_delete=models.SET_NULL, null=True, blank=True, related_name="synonyms",
        verbose_name="有效名", help_text="若此名為同物異名或舊組合，指向現行有效名；有效名本身留空。",
    )
    notes = models.TextField("備註", blank=True)

    class Meta:
        ordering = ["genus__name", "epithet", "subspecies"]
        verbose_name = verbose_name_plural = "物種"
        constraints = [
            models.UniqueConstraint(fields=["genus", "epithet", "subspecies"], name="unique_species_name"),
        ]

    def __str__(self):
        return self.name

    @property
    def name(self):
        parts = [self.genus.name, self.epithet]
        if self.subspecies:
            parts.append(self.subspecies)
        return " ".join(parts)

    @property
    def full_name(self):
        return f"{self.name} {self.author}".strip()

    @property
    def is_synonym(self):
        return self.valid_species_id is not None

    @property
    def accepted(self):
        return self.valid_species or self

    def name_group(self):
        """The accepted species and all names pointing to it."""
        accepted = self.accepted
        return Species.objects.filter(models.Q(pk=accepted.pk) | models.Q(valid_species=accepted))

    def all_figures(self):
        """Figures published under this name or any of its synonyms."""
        return Figure.objects.filter(species__in=self.name_group())

    def get_absolute_url(self):
        return reverse("species_detail", args=[self.pk])


class Reference(models.Model):
    authors = models.CharField("作者", max_length=500, help_text="例如 Ono, H. & Ogata, K.")
    year = models.CharField("年份", max_length=10, help_text="允許 2009a、2009b")
    title = models.TextField("標題")
    journal = models.CharField("期刊或書名", max_length=300, blank=True)
    volume = models.CharField("卷", max_length=30, blank=True)
    issue = models.CharField("期", max_length=30, blank=True)
    pages = models.CharField("頁碼", max_length=50, blank=True)
    publisher = models.CharField("出版者", max_length=200, blank=True, help_text="書籍才需填寫")
    doi = models.CharField("DOI", max_length=200, blank=True)
    url = models.URLField("網址", max_length=500, blank=True)
    wsc_ref_id = models.CharField("WSC 文獻 ID", max_length=50, blank=True)
    notes = models.TextField("備註", blank=True)

    class Meta:
        ordering = ["authors", "year"]
        verbose_name = verbose_name_plural = "文獻"

    def __str__(self):
        return f"{self.short_authors} {self.year}. {self.title[:60]}"

    @property
    def short_authors(self):
        """'Ono, H., Tanikawa, A. & Ogata, K.' -> 'Ono et al.'; two authors -> 'Ono & Ogata'."""
        tokens = re.split(r",\s*|\s*&\s*|\s+and\s+|;\s*", self.authors)
        surnames = [t.strip() for t in tokens if t.strip() and not INITIALS_RE.match(t.strip())]
        if not surnames:
            return self.authors
        if len(surnames) == 1:
            return surnames[0]
        if len(surnames) == 2:
            return f"{surnames[0]} & {surnames[1]}"
        return f"{surnames[0]} et al."

    def citation(self):
        """Full citation in a WSC-like style."""
        s = f"{self.authors} ({self.year}). {self.title.rstrip('.')}."
        if self.journal:
            s += f" {self.journal}"
            if self.volume:
                s += f" {self.volume}"
                if self.issue:
                    s += f"({self.issue})"
            if self.pages:
                s += f": {self.pages}" if self.volume else f", {self.pages}"
            s += "."
        if self.publisher:
            s += f" {self.publisher}."
        if self.doi:
            s += f" doi:{self.doi}"
        return s

    def bibtex(self):
        first = self.short_authors.split(" ")[0].replace(",", "")
        key = f"{first}{self.year}".replace(" ", "")
        fields = {
            "author": self.authors,
            "year": self.year,
            "title": "{" + self.title + "}",
            "journal": self.journal,
            "volume": self.volume,
            "number": self.issue,
            "pages": self.pages.replace("-", "--"),
            "publisher": self.publisher,
            "doi": self.doi,
            "url": self.url,
        }
        kind = "book" if self.publisher and not self.volume else "article"
        body = ",\n".join(f"  {k} = {{{v}}}" for k, v in fields.items() if v)
        return f"@{kind}{{{key},\n{body}\n}}"

    def doi_url(self):
        return f"https://doi.org/{self.doi}" if self.doi else ""

    def get_absolute_url(self):
        return reverse("reference_detail", args=[self.pk])


class Structure(models.Model):
    name = models.CharField("構造名稱", max_length=50, unique=True)
    name_en = models.CharField("英文名稱", max_length=80, blank=True)
    order = models.PositiveIntegerField("排序", default=100)

    class Meta:
        ordering = ["order", "name"]
        verbose_name = verbose_name_plural = "構造類別"

    def __str__(self):
        return f"{self.name}（{self.name_en}）" if self.name_en else self.name


def figure_upload_to(instance, filename):
    ext = Path(filename).suffix.lower() or ".jpg"
    return f"figures/original/{instance.species.genus.name}/{instance.species.epithet}_{_stamp()}{ext}"


def _stamp():
    from django.utils.crypto import get_random_string
    from django.utils.timezone import now
    return now().strftime("%Y%m%d%H%M%S") + "_" + get_random_string(6).lower()


class Figure(models.Model):
    SEX_CHOICES = [("", "未指定"), ("M", "♂ 雄"), ("F", "♀ 雌"), ("J", "幼體")]
    VIEW_CHOICES = [
        ("", "未指定"), ("dorsal", "背面"), ("ventral", "腹面"), ("lateral", "側面"),
        ("prolateral", "前側面"), ("retrolateral", "後側面"), ("frontal", "正面"),
        ("posterior", "後面"), ("other", "其他"),
    ]

    species = models.ForeignKey(Species, on_delete=models.PROTECT, related_name="figures",
                                verbose_name="物種（圖上使用的名稱）")
    reference = models.ForeignKey(Reference, on_delete=models.PROTECT, related_name="figures",
                                  verbose_name="出處文獻")
    figure_number = models.CharField("圖號", max_length=50, blank=True, help_text="例如 Fig. 12A")
    page = models.CharField("頁碼", max_length=30, blank=True)
    structure = models.ForeignKey(Structure, on_delete=models.SET_NULL, null=True, blank=True,
                                  related_name="figures", verbose_name="構造")
    sex = models.CharField("性別", max_length=1, choices=SEX_CHOICES, blank=True)
    view = models.CharField("視角", max_length=20, choices=VIEW_CHOICES, blank=True)
    image = models.ImageField("圖片", upload_to=figure_upload_to)
    medium = models.ImageField(upload_to="figures/medium/", blank=True, editable=False)
    thumbnail = models.ImageField(upload_to="figures/thumb/", blank=True, editable=False)
    notes = models.TextField("備註", blank=True)
    uploaded_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True,
                                    blank=True, editable=False, verbose_name="上傳者")
    created_at = models.DateTimeField("上傳時間", auto_now_add=True)
    updated_at = models.DateTimeField("更新時間", auto_now=True)

    class Meta:
        ordering = ["structure__order", "sex", "reference__year", "figure_number"]
        verbose_name = verbose_name_plural = "文獻圖片"

    def __str__(self):
        return f"{self.species.name} – {self.source_label}"

    @property
    def source_label(self):
        """Short source, e.g. 'Ono 2009: 123, fig. 12A'."""
        s = f"{self.reference.short_authors} {self.reference.year}"
        if self.page:
            s += f": {self.page}"
        if self.figure_number:
            s += f", {self.figure_number}"
        return s

    def get_absolute_url(self):
        return reverse("figure_detail", args=[self.pk])

    def save(self, *args, **kwargs):
        regenerate = kwargs.pop("regenerate", False)
        if self.pk and not regenerate:
            old_name = Figure.objects.filter(pk=self.pk).values_list("image", flat=True).first()
            regenerate = old_name is not None and old_name != self.image.name
        super().save(*args, **kwargs)
        if self.image and (regenerate or not self.thumbnail or not self.medium):
            self.make_derivatives()
            super().save(update_fields=["thumbnail", "medium"])

    def make_derivatives(self):
        self.image.open("rb")
        try:
            with Image.open(self.image) as img:
                img = ImageOps.exif_transpose(img)
                if img.mode not in ("RGB", "L"):
                    img = img.convert("RGB")
                stem = Path(self.image.name).stem
                for field, size in (("medium", MEDIUM_SIZE), ("thumbnail", THUMB_SIZE)):
                    copy = img.copy()
                    copy.thumbnail((size, size), Image.Resampling.LANCZOS)
                    buf = io.BytesIO()
                    copy.save(buf, format="JPEG", quality=88)
                    old = getattr(self, field)
                    if old:
                        old.delete(save=False)
                    getattr(self, field).save(f"{stem}.jpg", ContentFile(buf.getvalue()), save=False)
        finally:
            self.image.close()

    def delete(self, *args, **kwargs):
        files = [self.image, self.medium, self.thumbnail]
        result = super().delete(*args, **kwargs)
        for f in files:
            if f:
                f.delete(save=False)
        return result
